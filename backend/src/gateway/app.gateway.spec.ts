import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket as ServerSocket } from 'socket.io';
import { io, Socket } from 'socket.io-client';
import { Types } from 'mongoose';
import { AppGateway } from './app.gateway';
import { SocketAuthService } from './socket-auth.service';
import { SessionController } from '../modules/session/session.controller';
import { UserRole } from '../common/enums/user-role.enum';

// Real JWT verification and Socket.IO transport; only database access is mocked.
// Never loads AppModule, an environment file, or an application database URI.
describe('Socket authorization regressions', () => {
  const secret = 'socket-test-only-secret-012345678901234567890';
  const jwt = new JwtService();
  const sessionA = new Types.ObjectId().toString();
  const sessionB = new Types.ObjectId().toString();
  const tableA = new Types.ObjectId().toString();
  const tableB = new Types.ObjectId().toString();
  const dishId = new Types.ObjectId().toString();
  let http: HttpServer;
  let server: Server;
  let gateway: AppGateway;
  let auth: SocketAuthService;
  let url: string;
  const clients: Socket[] = [];
  const staff = new Map<string, { id: string; role: UserRole; isActive: boolean }>();
  const users = {
    findActiveAuthUser: jest.fn(async (id: string) => {
      const user = staff.get(id);
      return user?.isActive ? user : null;
    }),
  };
  const owners = new Map<string, string | string[]>();
  const tableIds = (sessionId: string) => [owners.get(sessionId) ?? []].flat();
  const sessions = {
    exists: jest.fn(async (query) =>
      tableIds(query._id).includes(query.tableIds),
    ),
  };
  const tables = {
    exists: jest.fn(async (query) =>
      tableIds(query.currentSessionId).includes(query._id),
    ),
  };
  const sessionService = {
    getCart: jest.fn(async (id: string) => ({
      sessionId: id,
      tableId: tableIds(id)[0],
      tableIds: tableIds(id),
      cart: [],
      version: 0,
    })),
    getOrCreateActiveSession: jest.fn(async (tableId: string) => ({
      sessionId: tableId === tableA ? sessionA : sessionB,
      tableId,
      cart: [],
      version: 0,
    })),
    addToCart: jest.fn(),
    updateCartQuantity: jest.fn(),
    removeFromCart: jest.fn(),
    getRealtimeOrderRooms: jest.fn(),
  };

  function event<T = any>(socket: Socket, name: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${name}`)),
        2000,
      );
      socket.once(name, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }
  function client(credentials: object) {
    const socket = io(url, {
      auth: credentials,
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      autoConnect: false,
    });
    clients.push(socket);
    return socket;
  }
  async function connect(credentials: object) {
    const socket = client(credentials);
    const ready = event(socket, 'connect');
    socket.connect();
    await ready;
    return socket;
  }
  function staffToken(role: UserRole, expiresIn = 900) {
    const sub = new Types.ObjectId().toString();
    staff.set(sub, { id: sub, role, isActive: true });
    return jwt.sign(
      {
        sub,
        email: 'staff@example.test',
        role,
      },
      { secret, expiresIn },
    );
  }
  async function send(
    socket: Socket,
    name: string,
    payload: unknown,
    response: string,
  ) {
    const result = event(socket, response);
    socket.emit(name, payload);
    return result;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    staff.clear();
    owners.clear();
    owners.set(sessionA, tableA);
    owners.set(sessionB, tableB);
    auth = new SocketAuthService(
      jwt,
      new ConfigService({ JWT_ACCESS_SECRET: secret }),
      sessions as never,
      tables as never,
      users as never,
    );
    gateway = new AppGateway(sessionService as never, auth);
    http = createServer();
    server = new Server(http);
    gateway.server = server;
    gateway.afterInit(server);
    server.on('connection', (socket: ServerSocket) => {
      void gateway.handleConnection(socket);
      socket.on('disconnect', () => gateway.handleDisconnect(socket));
      socket.on('join', (payload) => void gateway.joinRoom(socket, payload));
      socket.on(
        'cart:join',
        (payload) => void gateway.joinCart(socket, payload),
      );
      socket.on(
        'cart:add',
        (payload) => void gateway.addCartItem(payload, socket),
      );
      socket.on(
        'cart:update-quantity',
        (payload) => void gateway.updateCartQuantity(payload, socket),
      );
      socket.on(
        'cart:remove',
        (payload) => void gateway.removeCartItem(payload, socket),
      );
      socket.on(
        'waiter:call',
        (payload) => void gateway.callWaiter(payload, socket),
      );
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    clients.splice(0).forEach((socket) => socket.disconnect());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    jest.restoreAllMocks();
  });

  it('emits merged Order updates to the root Session and every physical table room', async () => {
    sessionService.getRealtimeOrderRooms.mockResolvedValueOnce([
      'session:root-session', 'table:a01', 'table:a02',
    ]);
    const order = { sessionId: 'root-session', tableId: 'a02' };
    const broadcast = jest.spyOn(server, 'to');
    await gateway.emitOrderUpdated(order);
    expect(broadcast).toHaveBeenCalledWith([
      'kitchen', 'waiter', 'session:root-session', 'table:a01', 'table:a02',
    ]);
  });

  it('rejects missing, forged and expired staff JWTs before room membership', async () => {
    const forged = jwt.sign(
      { sub: new Types.ObjectId().toString(), email: 'x@test', role: 'admin' },
      { secret: 'wrong-secret' },
    );
    for (const credentials of [
      {},
      { token: forged },
      { token: staffToken(UserRole.ADMIN, -1) },
    ]) {
      const socket = client(credentials);
      const rejected = event<Error>(socket, 'connect_error');
      socket.connect();
      expect((await rejected).message).toBe('Socket authentication required');
    }
    expect(server.sockets.sockets.size).toBe(0);
    expect(server.sockets.adapter.rooms.has('admin')).toBe(false);
  });

  it('maps verified staff roles to rooms/events and reauthenticates reconnects', async () => {
    const kitchen = await connect({
      token: staffToken(UserRole.KITCHEN),
      role: 'admin',
      room: 'admin',
    });
    const peer = server.sockets.sockets.get(kitchen.id!)!;
    expect(peer.rooms.has('kitchen')).toBe(true);
    expect(peer.rooms.has('admin')).toBe(false);
    expect(
      await send(kitchen, 'join', { room: 'waiter' }, 'join:error'),
    ).toContain('không được phép');
    await send(
      kitchen,
      'cart:add',
      { sessionId: sessionA, dishId },
      'cart:error',
    );
    expect(sessionService.addToCart).not.toHaveBeenCalled();
    kitchen.disconnect();
    kitchen.auth = { token: staffToken(UserRole.WAITER) };
    const ready = event(kitchen, 'connect');
    kitchen.connect();
    await ready;
    const reconnected = server.sockets.sockets.get(kitchen.id!)!;
    expect(reconnected.rooms.has('waiter')).toBe(true);
    expect(reconnected.rooms.has('kitchen')).toBe(false);
    const admin = await connect({ token: staffToken(UserRole.ADMIN) });
    for (const room of ['admin', 'kitchen', 'waiter'])
      expect(server.sockets.sockets.get(admin.id!)!.rooms.has(room)).toBe(true);
    reconnected.data.identity.exp = 1;
    const disconnected = event(kitchen, 'disconnect');
    kitchen.emit('join', { room: 'waiter' });
    await disconnected;
  });

  it('uses the current staff role on connect and rejects disabled staff', async () => {
    const token = staffToken(UserRole.ADMIN);
    const claims = jwt.verify(token, { secret });
    staff.get(claims.sub)!.role = UserRole.WAITER;
    const socket = await connect({ token });
    const peer = server.sockets.sockets.get(socket.id!)!;
    expect(peer.rooms.has('waiter')).toBe(true);
    expect(peer.rooms.has('admin')).toBe(false);
    expect(peer.rooms.has('kitchen')).toBe(false);
    socket.disconnect();
    staff.get(claims.sub)!.isActive = false;
    const disabled = client({ token });
    const rejected = event(disabled, 'connect_error');
    disabled.connect();
    await rejected;
  });

  it.each(['disabled', 'role-changed'] as const)(
    'drops %s staff before inbound events and staff broadcasts', async (change) => {
      const token = staffToken(UserRole.ADMIN);
      const claims = jwt.verify(token, { secret });
      const inbound = await connect({ token });
      const outbound = await connect({ token });
      if (change === 'disabled') staff.get(claims.sub)!.isActive = false;
      else staff.get(claims.sub)!.role = UserRole.WAITER;
      const inboundDisconnected = event(inbound, 'disconnect');
      inbound.emit('join', { room: 'admin' });
      await inboundDisconnected;
      const received = jest.fn();
      outbound.on('staff:private', received);
      const outboundDisconnected = event(outbound, 'disconnect');
      await gateway.emit('admin', 'staff:private', { secret: true });
      await outboundDisconnected;
      expect(received).not.toHaveBeenCalled();
    },
  );

  it('customer A cannot join/mutate B, spoof staff or bypass validation without joining first', async () => {
    const grant = await auth.issueCustomer(sessionA, tableA);
    const a = await connect({
      customerToken: grant.customerToken,
      role: 'admin',
    });
    for (const room of [
      `session:${sessionB}`,
      `table:${tableB}`,
      'admin',
      'kitchen',
    ]) {
      await send(a, 'join', { room }, 'join:error');
      expect(server.sockets.sockets.get(a.id!)!.rooms.has(room)).toBe(false);
    }
    await send(
      a,
      'cart:add',
      { sessionId: sessionB, dishId, quantity: 1 },
      'cart:error',
    );
    await send(a, 'waiter:call', { tableId: tableB }, 'waiter:call:error');
    await send(
      a,
      'cart:add',
      { sessionId: sessionA, dishId, quantity: '2' },
      'cart:error',
    );
    await send(
      a,
      'cart:add',
      { sessionId: { $ne: null }, dishId },
      'cart:error',
    );
    await send(
      a,
      'cart:add',
      { sessionId: sessionA, dishId, role: 'admin' },
      'cart:error',
    );
    expect(sessionService.addToCart).not.toHaveBeenCalled();
    owners.set(sessionA, tableB);
    await send(a, 'cart:add', { sessionId: sessionA, dishId }, 'cart:error');
    expect(sessionService.addToCart).not.toHaveBeenCalled();
    expect(
      server.sockets.sockets.get(a.id!)!.rooms.has(`table:${tableA}`),
    ).toBe(false);
    const received = jest.fn();
    a.on('cart:synced', received);
    const disconnected = event(a, 'disconnect');
    await gateway.emit(`session:${sessionA}`, 'cart:synced', { privateCart: true });
    await disconnected;
    expect(received).not.toHaveBeenCalled();
  });

  it('requires signed entry and preserves valid customer cart/call/reconnect flow with scoped expiry', async () => {
    const controller = new SessionController(
      sessionService as never,
      gateway,
      auth,
    );
    await expect(controller.getActive({ tableId: tableA })).rejects.toThrow();
    expect(sessionService.getOrCreateActiveSession).not.toHaveBeenCalled();
    const tableToken = await auth.issueTableEntry(tableA);
    await expect(
      controller.getActive({ tableId: tableB }, tableToken),
    ).rejects.toThrow();
    const response = await controller.getActive(
      { tableId: tableA },
      tableToken,
    );
    const claims = await auth.verifyCustomer(response.customerToken);
    expect(claims).toMatchObject({ sessionId: sessionA, tableId: tableA });
    expect(claims.exp * 1000 - Date.now()).toBeLessThanOrEqual(
      12 * 60 * 60 * 1000,
    );
    expect(claims.exp * 1000).toBeGreaterThan(Date.now());
    const a = await connect({ customerToken: response.customerToken });
    expect(
      await send(a, 'cart:join', { sessionId: sessionA }, 'cart:synced'),
    ).toMatchObject({ sessionId: sessionA });
    await send(
      a,
      'cart:add',
      { sessionId: sessionA, dishId, quantity: 2 },
      'cart:synced',
    );
    expect(sessionService.addToCart).toHaveBeenCalledWith(
      sessionA,
      dishId,
      2,
      undefined,
      undefined,
      undefined,
      tableA,
    );
    await send(a, 'waiter:call', { tableId: tableA }, 'waiter:call:accepted');
    expect(
      await send(a, 'waiter:call', { tableId: tableA }, 'waiter:call:error'),
    ).toContain('Vui lòng chờ');
    a.disconnect();
    const ready = event(a, 'connect');
    a.connect();
    await ready;
    await send(a, 'cart:join', { sessionId: sessionA }, 'cart:synced');
    expect(
      server.sockets.sockets
        .get(a.id!)!
        .rooms.has(`session:${sessionA}:table:${tableA}`),
    ).toBe(true);
    await expect(
      auth.authenticate({ customerToken: tableToken }),
    ).rejects.toThrow();
    await expect(
      auth.authenticate({ token: response.customerToken }),
    ).rejects.toThrow();
    owners.delete(sessionA);
    sessionService.getOrCreateActiveSession.mockClear();
    await expect(
      controller.getActive(
        { tableId: tableA },
        undefined,
        response.customerToken,
      ),
    ).rejects.toThrow();
    expect(sessionService.getOrCreateActiveSession).not.toHaveBeenCalled();
    // Even with valid QR proof, background reconnect is scoped and cannot open
    // a new session after cleanup/clear closed the old one.
    await expect(controller.getActive({ tableId: tableA, sessionId: sessionA }, tableToken)).rejects.toThrow();
    expect(sessionService.getOrCreateActiveSession).not.toHaveBeenCalled();
  });

  it('rebinds capability and rooms after staff-authorized move/merge/unmerge', async () => {
    const grant = await auth.issueCustomer(sessionA, tableA);
    const a = await connect({ customerToken: grant.customerToken });
    owners.set(sessionA, tableB);
    const authorized = event<{ customerToken: string; tableId: string }>(
      a,
      'session:authorized',
    );
    await gateway.moveClientsBetweenSessions(sessionA, sessionA);
    const updated = await authorized;
    expect(updated.tableId).toBe(tableB);
    const peer = server.sockets.sockets.get(a.id!)!;
    expect(peer.rooms.has(`session:${sessionA}:table:${tableA}`)).toBe(false);
    expect(peer.rooms.has(`session:${sessionA}:table:${tableB}`)).toBe(true);
    await expect(
      auth.authenticate({ customerToken: grant.customerToken }),
    ).rejects.toThrow();
    a.disconnect();
    a.auth = { customerToken: updated.customerToken };
    const ready = event(a, 'connect');
    a.connect();
    await ready;
    await send(a, 'cart:add', { sessionId: sessionA, dishId }, 'cart:synced');
    owners.delete(sessionA);
    owners.set(sessionB, [tableA, tableB]);
    const merged = event(a, 'session:authorized');
    await gateway.moveClientsBetweenSessions(sessionA, sessionB);
    expect((await merged).sessionId).toBe(sessionB);
    const currentPeer = server.sockets.sockets.get(a.id!)!;
    expect(currentPeer.rooms.has(`session:${sessionA}`)).toBe(false);
    expect(currentPeer.rooms.has(`session:${sessionB}:table:${tableB}`)).toBe(
      true,
    );
    owners.set(sessionA, tableB);
    owners.set(sessionB, tableA);
    const unmerged = event(a, 'session:authorized');
    await gateway.emitUnmergeResult({
      childSessionId: sessionA,
      rootSessionId: sessionB,
      tableIds: [tableB],
    });
    expect((await unmerged).sessionId).toBe(sessionA);
    expect(currentPeer.rooms.has(`session:${sessionB}`)).toBe(false);
    expect(currentPeer.rooms.has(`session:${sessionA}:table:${tableB}`)).toBe(
      true,
    );
    await send(a, 'cart:add', { sessionId: sessionB, dishId }, 'cart:error');
  });
});
