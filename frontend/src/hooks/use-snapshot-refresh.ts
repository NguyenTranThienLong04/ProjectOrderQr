import { useCallback, useEffect, useRef } from 'react';
import { createSnapshotRefresh } from '../services/snapshot-refresh';

export function useSnapshotRefresh<T>(
  fetchSnapshot: (signal: AbortSignal) => Promise<T>,
  apply: (snapshot: T) => void,
  onError: (error: unknown) => void,
) {
  const callbacks = useRef({ fetchSnapshot, apply, onError });
  callbacks.current = { fetchSnapshot, apply, onError };
  const runner = useRef<ReturnType<typeof createSnapshotRefresh<T>> | null>(null);
  useEffect(() => {
    const current = createSnapshotRefresh(
      (signal) => callbacks.current.fetchSnapshot(signal),
      (snapshot) => callbacks.current.apply(snapshot),
      (error) => callbacks.current.onError(error),
    );
    runner.current = current;
    void current.refresh();
    return () => { current.dispose(); runner.current = null; };
  }, []);
  return useCallback(() => runner.current?.refresh() ?? Promise.resolve(), []);
}
