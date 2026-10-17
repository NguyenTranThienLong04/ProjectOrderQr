import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { SessionService } from '../modules/session/session.service';
import { socketCorsOrigin } from '../common/config/public-urls';
import {
  SocketAuthService,
  SocketIdentity,
  STAFF_ROOMS,
} from './socket-auth.service';
import {
  AddCartPayload,
  CallWaiterPayload,
  JoinCartPayload,
  JoinRoomPayload,
  RemoveCartPayload,
  socketPayload,
  UpdateQuantityPayload,
} from './socket-payload.dto';

const WAITER_CALL_COOLDOWN_MS = 30_000;

@WebSocketGateway({
  cors: {
    origin: socketCorsOrigin,
  },
})
export class AppGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(AppGateway.name);
  /** Server-side timestamps make the 30-second cooldown independent of client clocks. */
  private readonly lastWaiterCallAt = new Map<string, number>();

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly sessionService: SessionService,
    private readonly socketAuth: SocketAuthService,
  ) {}

  afterInit(server: Server): void {
    server.use((client, next) => {
      void this.socketAuth
        .authenticate(client.handshake.auth)
        .then((identity) => {
          client.data.identity = identity;
          next();
        })
        .catch(() => next(new Error('Socket authentication required')));
    });
  }

  private identity(client: Socket): SocketIdentity | undefined {
    return client.data.identity as SocketIdentity | undefined;
  }

  // Physical table subscriptions must not survive into a different dining session.
  private tableRoom(sessionId: string, tableId: string): string {
    return `${this.room(sessionId)}:table:${tableId}`;
  }

  private expireConnection(client: Socket, identity: SocketIdentity) {
    clearTimeout(client.data.authTimer);
    client.data.authTimer = setTimeout(
      () => client.disconnect(true),
      Math.max(0, identity.exp * 1000 - Date.now()),
    );
    client.data.authTimer.unref();
  }

  private async rebindCustomer(client: Socket, toSessionId: string) {
    try {
      const identity = this.identity(client);
      this.socketAuth.assertFresh(identity);
      if (identity.kind !== 'customer')
        throw new WsException('Customer required');
      const cart = await this.sessionService.getCart(toSessionId);
      const tableId = cart.tableIds.includes(identity.tableId)
        ? identity.tableId
        : identity.sessionId === toSessionId && cart.tableIds.length === 1
          ? cart.tableId
          : undefined;
      if (!tableId) {
        client.disconnect(true);
        return;
      }
      const grant = await this.socketAuth.issueCustomer(toSessionId, tableId);
      await client.leave(this.room(identity.sessionId));
      await client.leave(this.tableRoom(identity.sessionId, identity.tableId));
      client.data.identity = await this.socketAuth.verifyCustomer(
        grant.customerToken,
      );
      await client.join([
        this.room(toSessionId),
        this.tableRoom(toSessionId, tableId),
      ]);
      this.expireConnection(client, client.data.identity);
      client.emit('session:authorized', grant);
    } catch {
      // A stale socket must lose its old rooms even if refreshing its grant fails.
      client.disconnect(true);
    }
  }

  private room(sessionId: string): string {
    return `session:${sessionId}`;
  }

  /** Called after close commits. Normal emit() requires an ACTIVE session and
   * would disconnect these customers before they could receive the close signal. */
  async endCustomerSession(sessionId: string): Promise<void> {
    for (const id of await this.server.in(this.room(sessionId)).allSockets()) {
      const client = this.server.sockets.sockets.get(id);
      if (!client) continue;
      const identity = this.identity(client);
      if (identity?.kind !== 'customer' || identity.sessionId !== sessionId)
        continue;
      client.emit('session:closed', { sessionId });
      client.disconnect(true);
    }
  }

  async emit(rooms: string | string[], event: string, payload?: unknown): Promise<void> {
    const targets = Array.isArray(rooms) ? rooms : [rooms];
    // Room membership is not lasting authorization, including staff roles.
    const recipients = new Set<string>();
    for (const room of targets.filter((target) =>
      target.startsWith('session:') || ['admin', 'kitchen', 'waiter'].includes(target),
    )) {
      for (const id of await this.server.in(room).allSockets()) recipients.add(id);
    }
    for (const id of recipients) {
      const client = this.server.sockets.sockets.get(id);
      if (!client) continue;
      try {
        const identity = this.identity(client);
        if (identity?.kind === 'staff')
          await this.socketAuth.authorizeStaff(identity);
        else
          await this.socketAuth.authorizeCustomer(identity);
      } catch {
        client.disconnect(true);
      }
    }
    this.server.to(targets).emit(event, payload);
  }

  async synchronizeSession(sessionId: string): Promise<void> {
    const cart = await this.sessionService.getCart(sessionId);
    await this.emit(this.room(sessionId), 'cart:synced', cart);
  }

  async emitOrderUpdated(
    order: {
      sessionId: { toString(): string };
      tableId: { toString(): string };
    },
    staffRooms: string[] = ['kitchen', 'waiter'],
  ): Promise<void> {
    const rooms = await this.sessionService.getRealtimeOrderRooms(
      order.sessionId.toString(),
      order.tableId.toString(),
    );
    await this.emit([...staffRooms, ...rooms], 'order:updated', order);
  }

  async emitUnmergeResult(result: {
    childSessionId: string;
    rootSessionId: string;
    tableIds: string[];
  }): Promise<void> {
    const socketIds = new Set<string>();
    for (const tableId of result.tableIds) {
      const tableSockets = await this.server
        .in(this.tableRoom(result.rootSessionId, tableId))
        .allSockets();
      tableSockets.forEach((socketId) => socketIds.add(socketId));
    }
    for (const socketId of socketIds) {
      const socket = this.server.sockets.sockets.get(socketId);
      if (!socket) continue;
      await this.rebindCustomer(socket, result.childSessionId);
      socket.emit('session:unmerged', result);
    }
    this.emit(
      [this.room(result.rootSessionId), this.room(result.childSessionId)],
      'session:unmerged',
      result,
    );
    await this.synchronizeSession(result.rootSessionId);
    await this.synchronizeSession(result.childSessionId);
  }

  /** Move all connected sockets from one session room to another.
   * Emits 'session:moved' to each moved socket and then emits a final
   * 'session:merged_or_moved' event to the target room. Works with the in-memory adapter;
   * for clustered deployments, a redis adapter and a coordinated approach are required.
   */
  async moveClientsBetweenSessions(
    fromSessionId: string,
    toSessionId: string,
  ): Promise<void> {
    try {
      const fromRoom = this.room(fromSessionId);
      const toRoom = this.room(toSessionId);
      // allSockets returns Set<string> of socket ids in this server instance
      const sockets = await this.server.in(fromRoom).allSockets();
      for (const socketId of sockets) {
        const socket = this.server.sockets.sockets.get(socketId);
        if (!socket) continue;
        await this.rebindCustomer(socket, toSessionId);
        socket.emit('session:moved', { fromSessionId, toSessionId });
      }
      // notify target room listeners (kitchen/waiter clients) and sync cart
      this.emit(toRoom, 'session:merged_or_moved', {
        toSessionId,
        fromSessionId,
        rootSessionId: toSessionId,
      });
    } catch (error) {
      this.logger.error('Failed to move clients between sessions', error);
    }
  }

  async emitMergeResult(
    result: {
      case: 'grouped' | 'joined' | 'merged';
      rootSessionId?: string;
      sourceSessionId?: string;
    },
    sourceTableId: string,
    targetTableId: string,
  ): Promise<void> {
    if (result.case === 'grouped') {
      this.emit(['waiter', 'admin'], 'table:grouped', {
        tableIds: [sourceTableId, targetTableId],
      });
      return;
    }
    if (result.case === 'joined') {
      this.emit(this.room(result.rootSessionId!), 'session:table-added', {
        rootSessionId: result.rootSessionId,
        tableIds: [sourceTableId, targetTableId],
      });
      return;
    }
    if (result.sourceSessionId && result.rootSessionId) {
      await this.moveClientsBetweenSessions(
        result.sourceSessionId,
        result.rootSessionId,
      );
      this.emit(`session:${result.rootSessionId}`, 'session:merged', {
        sourceSessionId: result.sourceSessionId,
        rootSessionId: result.rootSessionId,
      });
      await this.synchronizeSession(result.rootSessionId);
    }
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const identity = this.identity(client);
      this.socketAuth.assertFresh(identity);
      if (identity.kind === 'staff') {
        await this.socketAuth.authorizeStaff(identity);
        client.use((_packet, next) => {
          void this.socketAuth.authorizeStaff(this.identity(client))
            .then(() => next())
            .catch(() => client.disconnect(true));
        });
      }
      await client.join(
        identity.kind === 'staff'
          ? STAFF_ROOMS[identity.role]
          : [
              this.room(identity.sessionId),
              this.tableRoom(identity.sessionId, identity.tableId),
            ],
      );
      if (identity.kind === 'customer')
        await this.socketAuth.authorizeCustomer(identity);
      this.expireConnection(client, identity);
      this.logger.log(`Client connected: ${client.id}`);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    clearTimeout(client.data.authTimer);
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('cart:join')
  async joinCart(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: JoinCartPayload,
  ): Promise<void> {
    try {
      payload = socketPayload(JoinCartPayload, payload);
      await this.socketAuth.authorizeCustomer(
        this.identity(client),
        payload.sessionId,
      );
      const cart = await this.sessionService.getCart(payload.sessionId);
      await this.socketAuth.authorizeCustomer(this.identity(client), payload.sessionId);
      client.emit('cart:synced', cart);
    } catch (error) {
      client.emit(
        'cart:error',
        error instanceof Error ? error.message : 'Không thể đồng bộ giỏ hàng',
      );
    }
  }

  @SubscribeMessage('cart:add')
  async addCartItem(
    @MessageBody() payload: AddCartPayload,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    try {
      payload = socketPayload(AddCartPayload, payload);
      const identity = await this.socketAuth.authorizeCustomer(
        this.identity(client),
        payload.sessionId,
      );
      await this.sessionService.addToCart(
        payload?.sessionId,
        payload?.dishId,
        payload?.quantity ?? 1,
        payload?.note,
        payload?.analysisToken,
        payload?.confirmedByCustomer,
        identity.tableId,
      );
      await this.synchronizeSession(payload.sessionId);
    } catch (error) {
      client.emit(
        'cart:error',
        error instanceof Error ? error.message : 'Không thể thêm món',
      );
    }
  }

  @SubscribeMessage('cart:update-quantity')
  async updateCartQuantity(
    @MessageBody() payload: UpdateQuantityPayload,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    try {
      payload = socketPayload(UpdateQuantityPayload, payload);
      const identity = await this.socketAuth.authorizeCustomer(
        this.identity(client),
        payload.sessionId,
      );
      await this.sessionService.updateCartQuantity(
        payload?.sessionId,
        payload?.dishId,
        payload?.quantity,
        payload?.cartItemId,
        identity.tableId,
      );
      await this.synchronizeSession(payload.sessionId);
    } catch (error) {
      client.emit(
        'cart:error',
        error instanceof Error ? error.message : 'Không thể cập nhật giỏ hàng',
      );
    }
  }

  @SubscribeMessage('cart:remove')
  async removeCartItem(
    @MessageBody() payload: RemoveCartPayload,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    try {
      payload = socketPayload(RemoveCartPayload, payload);
      const identity = await this.socketAuth.authorizeCustomer(
        this.identity(client),
        payload.sessionId,
      );
      await this.sessionService.removeFromCart(
        payload?.sessionId,
        payload?.dishId,
        payload?.cartItemId,
        identity.tableId,
      );
      await this.synchronizeSession(payload.sessionId);
    } catch (error) {
      client.emit(
        'cart:error',
        error instanceof Error ? error.message : 'Không thể xóa món',
      );
    }
  }

  @SubscribeMessage('join')
  async joinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: JoinRoomPayload,
  ): Promise<void> {
    try {
      payload = socketPayload(JoinRoomPayload, payload);
      const identity = this.identity(client);
      this.socketAuth.assertFresh(identity);
      let room = payload.room;
      if (identity.kind === 'staff') {
        await this.socketAuth.authorizeStaff(identity);
        if (!STAFF_ROOMS[identity.role].includes(room))
          throw new WsException('Room không được phép');
      } else {
        await this.socketAuth.authorizeCustomer(identity);
        if (room === `table:${identity.tableId}`)
          room = this.tableRoom(identity.sessionId, identity.tableId);
        else if (room !== this.room(identity.sessionId))
          throw new WsException('Room không được phép');
      }
      // Customer rooms were chosen by the server at connect/rebind, never by a join request.
      if (identity.kind === 'staff') await client.join(room);
      client.emit('joined', { room: payload.room });
    } catch (error) {
      client.emit(
        'join:error',
        error instanceof Error ? error.message : 'Không thể tham gia room',
      );
    }
  }

  @SubscribeMessage('waiter:call')
  async callWaiter(
    @MessageBody() payload: CallWaiterPayload,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    try {
      payload = socketPayload(CallWaiterPayload, payload);
      await this.socketAuth.authorizeCustomer(
        this.identity(client),
        undefined,
        payload.tableId,
      );
    } catch (error) {
      client.emit(
        'waiter:call:error',
        error instanceof Error ? error.message : 'Không có quyền gọi phục vụ',
      );
      return;
    }
    const tableId = payload.tableId;

    const now = Date.now();
    const lastCalledAt = this.lastWaiterCallAt.get(tableId);
    if (lastCalledAt && now - lastCalledAt < WAITER_CALL_COOLDOWN_MS) {
      const retryAfterSeconds = Math.ceil(
        (WAITER_CALL_COOLDOWN_MS - (now - lastCalledAt)) / 1000,
      );
      client.emit(
        'waiter:call:error',
        `Vui lòng chờ ${retryAfterSeconds}s trước khi gọi phục vụ lại`,
      );
      return;
    }

    this.lastWaiterCallAt.set(tableId, now);
    // Bound the in-memory limiter even when a restaurant has many historical tables.
    for (const [calledTableId, calledAt] of this.lastWaiterCallAt) {
      if (now - calledAt >= WAITER_CALL_COOLDOWN_MS) {
        this.lastWaiterCallAt.delete(calledTableId);
      }
    }
    const call = { tableId, timestamp: new Date(now).toISOString() };
    this.emit(['waiter', 'admin'], 'waiter:called', call);
    client.emit('waiter:call:accepted', call);
  }
}
