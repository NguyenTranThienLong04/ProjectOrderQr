import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
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

interface JoinCartPayload {
  sessionId: string;
}
interface AddCartPayload {
  sessionId: string;
  dishId: string;
  quantity?: number;
  note?: string;
  analysisToken?: unknown;
  confirmedByCustomer?: unknown;
}
interface UpdateQuantityPayload {
  sessionId: string;
  dishId: string;
  cartItemId?: string;
  quantity: number;
}
interface RemoveCartPayload {
  sessionId: string;
  dishId: string;
  cartItemId?: string;
}
interface CallWaiterPayload {
  tableId: string;
}

const WAITER_CALL_COOLDOWN_MS = 30_000;

@WebSocketGateway({
  cors: {
    origin: socketCorsOrigin,
  },
})
export class AppGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AppGateway.name);
  /** Server-side timestamps make the 30-second cooldown independent of client clocks. */
  private readonly lastWaiterCallAt = new Map<string, number>();

  @WebSocketServer()
  server!: Server;

  constructor(private readonly sessionService: SessionService) {}

  private room(sessionId: string): string {
    return `session:${sessionId}`;
  }

  emit(rooms: string | string[], event: string, payload?: unknown): void {
    const targets = Array.isArray(rooms) ? rooms : [rooms];
    this.server.to(targets).emit(event, payload);
  }

  async synchronizeSession(sessionId: string): Promise<void> {
    const cart = await this.sessionService.getCart(sessionId);
    this.emit(this.room(sessionId), 'cart:synced', cart);
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
    this.emit([...staffRooms, ...rooms], 'order:updated', order);
  }

  async emitUnmergeResult(result: {
    childSessionId: string;
    rootSessionId: string;
    tableIds: string[];
  }): Promise<void> {
    const socketIds = new Set<string>();
    for (const tableId of result.tableIds) {
      const tableSockets = await this.server
        .in(`table:${tableId}`)
        .allSockets();
      tableSockets.forEach((socketId) => socketIds.add(socketId));
    }
    for (const socketId of socketIds) {
      const socket = this.server.sockets.sockets.get(socketId);
      if (!socket) continue;
      await socket.join(this.room(result.childSessionId));
      await socket.leave(this.room(result.rootSessionId));
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
        await socket.join(toRoom);
        await socket.leave(fromRoom);
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
      this.emit(
        [`table:${sourceTableId}`, `table:${targetTableId}`],
        'session:table-added',
        {
          rootSessionId: result.rootSessionId,
          tableIds: [sourceTableId, targetTableId],
        },
      );
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

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('cart:join')
  async joinCart(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: JoinCartPayload,
  ): Promise<void> {
    try {
      if (!payload?.sessionId) throw new WsException('Thiếu sessionId');
      await client.join(this.room(payload.sessionId));
      const cart = await this.sessionService.getCart(payload.sessionId);
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
      await this.sessionService.addToCart(
        payload?.sessionId,
        payload?.dishId,
        payload?.quantity ?? 1,
        payload?.note,
        payload?.analysisToken,
        payload?.confirmedByCustomer,
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
      await this.sessionService.updateCartQuantity(
        payload?.sessionId,
        payload?.dishId,
        payload?.quantity,
        payload?.cartItemId,
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
      await this.sessionService.removeFromCart(
        payload?.sessionId,
        payload?.dishId,
        payload?.cartItemId,
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
    @MessageBody() payload: { room: string },
  ): Promise<void> {
    try {
      if (!payload?.room) throw new WsException('Thiếu room');
      await client.join(payload.room);
      client.emit('joined', { room: payload.room });
    } catch (error) {
      client.emit(
        'join:error',
        error instanceof Error ? error.message : 'Không thể tham gia room',
      );
    }
  }

  @SubscribeMessage('waiter:call')
  callWaiter(
    @MessageBody() payload: CallWaiterPayload,
    @ConnectedSocket() client: Socket,
  ): void {
    const tableId = payload?.tableId?.trim();
    if (!tableId) {
      client.emit('waiter:call:error', 'Thiếu mã bàn để gọi phục vụ');
      return;
    }

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
