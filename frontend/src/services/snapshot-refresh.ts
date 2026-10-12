import type { Socket } from 'socket.io-client';

// One request at a time. An event during a request invalidates its result and
// queues another snapshot; callers await the whole drain, not just the first GET.
export function createSnapshotRefresh<T>(
  fetchSnapshot: (signal: AbortSignal) => Promise<T>,
  apply: (snapshot: T) => void,
  onError: (error: unknown) => void,
) {
  let active = true;
  let pending = false;
  let running: Promise<void> | null = null;
  let controller: AbortController | null = null;
  return {
    refresh(): Promise<void> {
      if (!active) return Promise.resolve();
      pending = true;
      if (running) return running;
      running = (async () => {
        while (active && pending) {
          pending = false;
          controller = new AbortController();
          try {
            const snapshot = await fetchSnapshot(controller.signal);
            if (active && !pending) apply(snapshot);
          } catch (error) {
            if (active && !pending) onError(error);
          } finally {
            // Also cancel sibling GETs if a Promise.all snapshot failed early.
            controller.abort();
          }
        }
      })().finally(() => { running = null; controller = null; });
      return running;
    },
    dispose() {
      active = false;
      pending = false;
      controller?.abort();
    },
  };
}

export function bindSnapshotRecovery(
  socket: Pick<Socket, 'on' | 'off'>,
  refresh: () => Promise<void>,
  join?: () => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
) {
  const resync = () => { void refresh(); };
  const connect = () => { join?.(); resync(); };
  socket.on('connect', connect);
  target.addEventListener('focus', resync);
  target.addEventListener('online', resync);
  return () => {
    socket.off('connect', connect);
    target.removeEventListener('focus', resync);
    target.removeEventListener('online', resync);
  };
}
