import { AppGateway } from './app.gateway';

describe('AppGateway waiter:call', () => {
  const sessionService = {
    getCart: jest.fn(),
    getRealtimeOrderRooms: jest.fn(),
  };
  let gateway: AppGateway;
  let serverEmit: jest.Mock;
  let clientEmit: jest.Mock;

  beforeEach(() => {
    gateway = new AppGateway(sessionService as never);
    serverEmit = jest.fn();
    gateway.server = { to: jest.fn(() => ({ emit: serverEmit })) } as never;
    clientEmit = jest.fn();
  });

  it('broadcasts a valid customer call to waiter and admin rooms', async () => {
    await gateway.callWaiter({ tableId: 'table-1' }, {
      emit: clientEmit,
    } as never);

    expect(gateway.server.to).toHaveBeenCalledWith(['waiter', 'admin']);
    expect(serverEmit).toHaveBeenCalledWith(
      'waiter:called',
      expect.objectContaining({
        tableId: 'table-1',
        timestamp: expect.any(String),
      }),
    );
    expect(clientEmit).toHaveBeenCalledWith(
      'waiter:call:accepted',
      expect.objectContaining({ tableId: 'table-1' }),
    );
  });

  it('rejects another call from the same table during the 30 second cooldown', async () => {
    const client = { emit: clientEmit } as never;
    await gateway.callWaiter({ tableId: 'table-1' }, client);
    await gateway.callWaiter({ tableId: 'table-1' }, client);

    expect(serverEmit).toHaveBeenCalledTimes(1);
    expect(clientEmit).toHaveBeenLastCalledWith(
      'waiter:call:error',
      expect.stringContaining('Vui lòng chờ'),
    );
  });

  it('rejects a payload without a table id clearly', async () => {
    await gateway.callWaiter({ tableId: '   ' }, { emit: clientEmit } as never);

    expect(serverEmit).not.toHaveBeenCalled();
    expect(clientEmit).toHaveBeenCalledWith(
      'waiter:call:error',
      'Thiếu mã bàn để gọi phục vụ',
    );
  });

  it('emits merged Order updates to the root Session and every physical table room', async () => {
    sessionService.getRealtimeOrderRooms.mockResolvedValueOnce([
      'session:root-session',
      'table:a01',
      'table:a02',
    ]);
    const order = { sessionId: 'root-session', tableId: 'a02' };

    await gateway.emitOrderUpdated(order);

    expect(gateway.server.to).toHaveBeenCalledWith([
      'kitchen',
      'waiter',
      'session:root-session',
      'table:a01',
      'table:a02',
    ]);
    expect(serverEmit).toHaveBeenCalledWith('order:updated', order);
  });
});
