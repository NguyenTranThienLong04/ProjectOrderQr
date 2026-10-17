import type { Socket } from 'socket.io-client';
import { menuApi, type PublicMenu, type SharedCart } from './api/menu';
import { paymentApi, type SessionPaymentSummary } from './api/payment';
import { forgetCustomerGrant, isSessionUnavailable, SessionScopeError, type CustomerGrant } from './customer-access';
import { bindSnapshotRecovery, createSnapshotRefresh } from './snapshot-refresh';

export interface CustomerScope { sessionId: string; tableId: string; }

export function newerCart(current: SharedCart | null, next: SharedCart, sessionId: string) {
  if (next.sessionId !== sessionId || !Number.isSafeInteger(next.version)) return current;
  if (current?.sessionId === sessionId && next.version <= current.version) return current;
  return next;
}

export function startCustomerRecovery(socket: Socket, options: {
  scope: CustomerScope;
  lang: 'vi' | 'en';
  initialCart: SharedCart | null;
  onCart: (cart: SharedCart) => void;
  onSnapshot: (menu: PublicMenu, summary: SessionPaymentSummary) => void;
  onScope: (scope: CustomerScope) => void;
  onError: (error: unknown, expired: boolean) => void;
}) {
  const { scope } = options;
  let active = true;
  let cart = options.initialCart;
  const accept = (next: SharedCart) => {
    if (!active) return;
    const accepted = newerCart(cart, next, scope.sessionId);
    if (accepted !== cart && accepted) { cart = accepted; options.onCart(accepted); }
  };
  const runner = createSnapshotRefresh(
    async (signal) => {
      // Always pass the existing session: this endpoint must never create one
      // during background recovery, even when a signed QR is still cached.
      const next = await menuApi.getActiveSession(scope.tableId, scope.sessionId, signal);
      const [menu, summary] = await Promise.all([
        menuApi.get(scope.tableId, options.lang, signal),
        paymentApi.getSessionSummary(scope.sessionId, scope.tableId, signal),
      ]);
      return { cart: next, menu, summary };
    },
    (snapshot) => { accept(snapshot.cart); options.onSnapshot(snapshot.menu, snapshot.summary); },
    (error) => fail(error),
  );
  const refresh = () => runner.refresh();
  const unbind = bindSnapshotRecovery(socket, refresh, () => {
    socket.emit('cart:join', { sessionId: scope.sessionId });
  });
  const synced = (next: SharedCart) => {
    if (next.sessionId !== scope.sessionId) return;
    accept(next);
    void refresh();
  };
  const authorized = (grant: CustomerGrant) => {
    if (grant.sessionId === scope.sessionId && grant.tableId === scope.tableId) return;
    // Only a server-issued grant can change the scope. Discard every old read.
    dispose();
    options.onScope({ sessionId: grant.sessionId, tableId: grant.tableId });
  };
  const changed = () => { void refresh(); };
  const closed = (event: { sessionId?: string }) => {
    if (event.sessionId === scope.sessionId) fail(new SessionScopeError());
  };
  const disconnected = (reason: string) => {
    if (reason === 'io server disconnect') void refresh();
  };
  const events = ['session:table-added', 'session:merged', 'session:merged_or_moved', 'session:unmerged', 'order:updated', 'session:payment-updated'];
  socket.on('cart:synced', synced);
  socket.on('session:authorized', authorized);
  socket.on('session:closed', closed);
  socket.on('disconnect', disconnected);
  events.forEach((event) => socket.on(event, changed));
  function dispose() {
    active = false;
    runner.dispose();
    unbind();
    socket.off('cart:synced', synced);
    socket.off('session:authorized', authorized);
    socket.off('session:closed', closed);
    socket.off('disconnect', disconnected);
    events.forEach((event) => socket.off(event, changed));
  }
  function fail(error: unknown) {
    if (!active) return;
    const expired = isSessionUnavailable(error);
    if (expired) { dispose(); forgetCustomerGrant(scope.sessionId, scope.tableId); socket.disconnect(); }
    options.onError(error, expired);
  }
  void refresh(); // HTTP also recovers when Socket cannot connect at all.
  return { refresh, dispose, fail };
}
