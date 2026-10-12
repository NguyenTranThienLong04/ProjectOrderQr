import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import axios, { AxiosError } from 'axios';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/config/api-url')) return { url: 'data:text/javascript,export const API_URL = "http://recovery.test";', shortCircuit: true };
    if (specifier === 'socket.io-client') return { url: 'data:text/javascript,export const io = (...args) => globalThis.makeSocket(...args);', shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { axiosClient } = await import('../src/services/api/axios-client.ts');
const { menuApi } = await import('../src/services/api/menu.ts');
const { orderApi } = await import('../src/services/api/order.ts');
const { tableApi } = await import('../src/services/api/table.ts');
const { sessionApi } = await import('../src/services/api/session.ts');
const { paymentApi } = await import('../src/services/api/payment.ts');
const { createCustomerSocket, createStaffSocket } = await import('../src/services/socket-client.ts');
const { startCustomerRecovery, newerCart } = await import('../src/services/customer-recovery.ts');
const { createSnapshotRefresh, bindSnapshotRecovery } = await import('../src/services/snapshot-refresh.ts');
const { createPaymentRecovery } = await import('../src/services/payment-recovery.ts');

class FakeSocket extends EventEmitter {
  connected = false;
  sent = [];
  connections = 0;
  disconnects = 0;
  emit(name, ...args) { this.sent.push([name, ...args]); return true; }
  receive(name, ...args) { if (name === 'connect') this.connected = true; return super.emit(name, ...args); }
  connect() { this.connections += 1; return this; }
  disconnect() { this.connected = false; this.disconnects += 1; return this; }
}
class Browser extends EventTarget {
  listeners = new Set();
  location = { pathname: '/menu', search: '?tableId=table-a', href: '/menu' };
  addEventListener(name, listener) { this.listeners.add(listener); super.addEventListener(name, listener); }
  removeEventListener(name, listener) { super.removeEventListener(name, listener); this.listeners.delete(listener); }
}
const tick = () => new Promise((done) => setImmediate(done));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const response = (config, data) => ({ config, data, status: 200, statusText: 'OK', headers: {} });
const failure = (config, status) => new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, null, { ...response(config, {}), status });
const scope = { sessionId: 'session-a', tableId: 'table-a' };
const cart = (version, sessionId = scope.sessionId) => ({ ...scope, sessionId, version, cart: [{ dishId: 'dish', quantity: version }], customerToken: `grant-${sessionId}-${version}`, expiresAt: Date.now() + 60000 });
const summary = { ...scope, orders: [], payableOrders: [] };
const menu = { table: { id: scope.tableId }, categories: [] };
function customer(socket, overrides = {}) {
  const seen = { carts: [], snapshots: [], errors: [], scopes: [] };
  const recovery = startCustomerRecovery(socket, {
    scope, lang: 'vi', initialCart: cart(1),
    onCart: (value) => seen.carts.push(value),
    onSnapshot: (...values) => seen.snapshots.push(values),
    onScope: (value) => seen.scopes.push(value),
    onError: (error, expired) => seen.errors.push({ error, expired }),
    ...overrides,
  });
  return { recovery, seen };
}
beforeEach(() => {
  const storage = new Map();
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) };
  globalThis.window = new Browser();
  globalThis.makeSocket = () => new FakeSocket();
  axios.defaults.adapter = () => { throw new Error('Staff refresh must not run for customer recovery'); };
});

describe('1. Customer reconnect and snapshot ordering', () => {
  test('reconnect joins and fetches the scoped HTTP cart; old HTTP/events cannot overwrite newer versions', async (t) => {
    const socket = new FakeSocket();
    let version = 2;
    let held;
    const calls = [];
    axiosClient.defaults.adapter = async (config) => {
      calls.push(config);
      if (config.url === '/sessions/active') {
        assert.deepEqual(config.params, scope);
        assert.equal(config.timeout, 10000);
        return response(config, held ? await held.promise : cart(version));
      }
      return response(config, config.url === '/menu' ? menu : summary);
    };
    const { recovery, seen } = customer(socket);
    t.after(() => recovery.dispose());
    await tick();
    version = 4;
    socket.receive('connect');
    await tick();
    assert.deepEqual(socket.sent.at(-1), ['cart:join', { sessionId: scope.sessionId }]);
    assert.equal(seen.carts.at(-1).version, 4);
    held = deferred();
    const old = held;
    socket.receive('connect');
    await tick();
    socket.receive('cart:synced', cart(7));
    assert.equal(seen.carts.at(-1).version, 7);
    held = undefined; version = 8;
    old.resolve(cart(5));
    await tick();
    socket.receive('cart:synced', cart(3));
    socket.receive('cart:synced', cart(99, 'wrong-session'));
    await tick();
    assert.deepEqual(seen.carts.map((value) => value.version), [2, 4, 7, 8]);
    assert.equal(seen.errors.length, 0);
    assert.ok(calls.some((config) => config.url === '/vnpay/session-summary'));
    assert.equal(socket.listenerCount('connect'), 1);
    recovery.dispose();
    assert.equal(socket.listenerCount('connect'), 0);
    assert.equal(window.listeners.size, 0);
  });

  test('a new authorized scope cancels old reads and cannot receive an old session snapshot', async () => {
    const old = deferred();
    let signal;
    axiosClient.defaults.adapter = async (config) => {
      signal = config.signal;
      return response(config, await old.promise);
    };
    const socket = new FakeSocket();
    const { recovery, seen } = customer(socket);
    await tick();
    const next = { sessionId: 'session-b', tableId: 'table-b', customerToken: 'signed-grant' };
    socket.receive('session:authorized', next);
    assert.equal(signal.aborted, true);
    old.resolve(cart(20));
    await tick();
    assert.deepEqual(seen.scopes, [{ sessionId: 'session-b', tableId: 'table-b' }]);
    assert.deepEqual(seen.carts, []);
    assert.equal(newerCart(cart(4, 'session-b'), cart(30), 'session-b').version, 4);
    recovery.dispose();
  });
});

describe('2. Kitchen/Waiter do not drop refreshes during a request', () => {
  test('staff retries a failed handshake on focus/online and stops reconnecting after cleanup', async () => {
    let options;
    globalThis.makeSocket = (_url, config) => { options = config; return new FakeSocket(); };
    const socket = createStaffSocket();
    socket.receive('connect_error');
    window.dispatchEvent(new Event('focus'));
    assert.equal(socket.connections, 1);
    window.dispatchEvent(new Event('online'));
    assert.equal(socket.connections, 2);
    const held = deferred();
    axiosClient.defaults.adapter = async (config) => response(config, await held.promise);
    const authenticated = [];
    options.auth((credentials) => authenticated.push(credentials));
    await tick();
    socket.disconnect();
    held.resolve({ user: { role: 'waiter' } });
    await tick();
    window.dispatchEvent(new Event('focus'));
    assert.equal(socket.connections, 2);
    assert.equal(window.listeners.size, 0);
    assert.deepEqual(authenticated, []);
  });

  for (const screen of ['Kitchen', 'Waiter']) test(`${screen}: event burst during GET is coalesced into one final fresh snapshot`, async () => {
    const socket = new FakeSocket();
    const held = deferred();
    let requests = 0;
    const primaryUrl = screen === 'Kitchen' ? '/orders/kitchen' : '/orders/waiter';
    axiosClient.defaults.adapter = async (config) => {
      if (config.url !== primaryUrl) return response(config, []);
      requests += 1;
      return response(config, requests === 1 ? await held.promise : [{ orderId: 'latest' }]);
    };
    const snapshots = [];
    const runner = createSnapshotRefresh(
      (signal) => screen === 'Kitchen' ? orderApi.listForKitchen(signal) : Promise.all([
        orderApi.listForWaiter(signal), tableApi.findAll(signal), orderApi.listPaymentSummariesForWaiter(signal), sessionApi.getTableOperationOptions(signal),
      ]),
      (snapshot) => snapshots.push(screen === 'Kitchen' ? snapshot : snapshot[0]),
      (error) => { throw error; },
    );
    const unbind = bindSnapshotRecovery(socket, runner.refresh);
    socket.on('order:updated', runner.refresh);
    socket.receive('connect');
    await tick();
    for (let n = 0; n < 8; n += 1) socket.receive('order:updated');
    window.dispatchEvent(new Event('focus'));
    held.resolve([{ orderId: 'old' }]);
    await tick();
    assert.equal(requests, 2);
    assert.deepEqual(snapshots, [[{ orderId: 'latest' }]]);
    socket.receive('connect');
    await tick();
    assert.equal(requests, 3);
    unbind(); runner.dispose(); socket.removeAllListeners();
    window.dispatchEvent(new Event('focus'));
    socket.receive('connect');
    await tick();
    assert.equal(requests, 3);
    assert.equal(window.listeners.size, 0);
  });

  test('unmount aborts an in-flight snapshot and prevents late state updates', async () => {
    const held = deferred();
    let signal;
    const applied = [];
    const runner = createSnapshotRefresh(async (current) => { signal = current; return held.promise; }, (value) => applied.push(value), (error) => applied.push(error));
    const pending = runner.refresh();
    runner.dispose();
    assert.equal(signal.aborted, true);
    held.resolve('late');
    await pending;
    assert.deepEqual(applied, []);
  });
});

describe('3. Payment verification is independent of Socket', () => {
  test('offline Socket still reaches Paid via bounded HTTP retry/backoff', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const states = [];
    axiosClient.defaults.adapter = async (config) => {
      assert.equal(config.timeout, 5000);
      calls += 1;
      if (calls === 1) throw new Error('temporary network failure');
      return response(config, { ...scope, txnRef: 'txn', status: calls === 2 ? 'pending' : 'succeeded', invoiceCode: 'SERVER-INVOICE' });
    };
    const recovery = createPaymentRecovery((signal) => paymentApi.getPaymentStatus('txn', scope.sessionId, scope.tableId, signal), (state, payment) => states.push([state, payment?.invoiceCode]));
    await recovery.check();
    t.mock.timers.tick(999); await tick(); assert.equal(calls, 1);
    t.mock.timers.tick(1); await tick(); assert.equal(calls, 2);
    t.mock.timers.tick(2000); await tick();
    assert.equal(calls, 3);
    assert.deepEqual(states.at(-1), ['paid', 'SERVER-INVOICE']);
    t.mock.timers.tick(60000); await recovery.check();
    assert.equal(calls, 3);
    const socket = new FakeSocket();
    const unbind = bindSnapshotRecovery(socket, recovery.recheck);
    socket.receive('connect'); await tick();
    assert.equal(calls, 4);
    assert.equal(states.at(-1)[0], 'paid');
    unbind();
    recovery.dispose();
  });

  test('pending/error stops at five attempts with unknown; reconnect can verify again', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    let status = 'pending';
    const states = [];
    const socket = new FakeSocket();
    const recovery = createPaymentRecovery(async () => { calls += 1; return { ...scope, txnRef: 'txn', status }; }, (state) => states.push(state));
    const unbind = bindSnapshotRecovery(socket, recovery.recheck);
    await recovery.check();
    for (const delay of [1000, 2000, 4000, 8000]) { t.mock.timers.tick(delay); await tick(); }
    assert.equal(calls, 5);
    assert.equal(states.at(-1), 'unknown');
    t.mock.timers.tick(100000); await tick(); assert.equal(calls, 5);
    status = 'failed';
    socket.receive('connect'); await tick();
    assert.equal(calls, 6);
    assert.equal(states.at(-1), 'failed');
    unbind(); recovery.dispose();
  });

  test('reconnect during a pending GET cannot reset its retry budget; dispose clears timers', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const held = deferred();
    let calls = 0;
    const states = [];
    const recovery = createPaymentRecovery(async () => { calls += 1; return calls === 1 ? held.promise : { status: 'pending' }; }, (state) => states.push(state));
    const pending = recovery.check();
    for (let n = 0; n < 12; n += 1) void recovery.check();
    held.resolve({ status: 'pending' }); await pending;
    t.mock.timers.tick(0); await tick();
    assert.equal(calls, 2);
    recovery.dispose();
    t.mock.timers.tick(100000); await tick();
    assert.equal(calls, 2);
    assert.deepEqual(states, ['pending']);
  });
});

describe('4. Expired/invalid session recovery never opens another session', () => {
  test('401/404 ends recovery, keeps the exact scope and never redirects to staff login', async () => {
    for (const status of [401, 404]) {
      let calls = 0;
      axiosClient.defaults.adapter = async (config) => {
        calls += 1;
        assert.deepEqual(config.params, scope);
        throw failure(config, status);
      };
      const socket = new FakeSocket();
      const { recovery, seen } = customer(socket);
      await tick();
      assert.equal(seen.errors.length, 1);
      assert.equal(seen.errors[0].expired, true);
      assert.equal(socket.disconnects, 1);
      assert.equal(window.location.href, '/menu');
      window.dispatchEvent(new Event('focus')); socket.receive('connect');
      await recovery.refresh(); await tick();
      assert.equal(calls, 1);
      assert.deepEqual(seen.carts, []);
      recovery.dispose();
    }
  });

  test('a mismatched HTTP session cannot replace the saved customer grant', async () => {
    localStorage.setItem('customer-table:table-a', 'existing-grant');
    axiosClient.defaults.adapter = async (config) => response(config, cart(2, 'other-session'));
    await assert.rejects(menuApi.getActiveSession(scope.tableId, scope.sessionId), /Phiên tại bàn đã thay đổi/);
    assert.equal(localStorage.getItem('customer-table:table-a'), 'existing-grant');
    assert.equal(localStorage.getItem('customer-socket:other-session:table-a'), null);
  });

  test('socket renewal is bounded and cleanup cancels pending renewal/listeners', async () => {
    let calls = 0;
    let socket;
    globalThis.makeSocket = () => { socket = new FakeSocket(); return socket; };
    axiosClient.defaults.adapter = async (config) => {
      calls += 1; assert.deepEqual(config.params, scope); return response(config, cart(2));
    };
    const customerSocket = createCustomerSocket(scope.tableId, scope.sessionId);
    for (let n = 0; n < 6; n += 1) { socket.receive('connect_error'); await tick(); }
    assert.equal(calls, 2);
    assert.equal(socket.connections, 2);
    const held = deferred();
    let signal;
    axiosClient.defaults.adapter = async (config) => { signal = config.signal; return response(config, await held.promise); };
    window.dispatchEvent(new Event('online')); await tick();
    customerSocket.disconnect();
    assert.equal(signal.aborted, true);
    assert.equal(window.listeners.size, 0);
    held.resolve(cart(3)); await tick();
    assert.equal(socket.connections, 2);
  });
});
