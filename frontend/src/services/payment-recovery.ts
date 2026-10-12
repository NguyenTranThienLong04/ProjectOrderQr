import type { PaymentStatus } from './api/payment';

export type PaymentRecoveryStatus = 'pending' | 'paid' | 'failed' | 'unknown';

// At most five GETs per recovery cycle, each with the API's five-second timeout.
// Events can expedite a pending retry, but cannot reset a running cycle's budget.
export function createPaymentRecovery(
  verify: (signal: AbortSignal) => Promise<PaymentStatus>,
  onStatus: (status: PaymentRecoveryStatus, payment?: PaymentStatus) => void,
  delays: readonly number[] = [1000, 2000, 4000, 8000],
) {
  let active = true;
  let terminal = false;
  let attempts = 0;
  let inCycle = false;
  let pending = false;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const check = (): Promise<void> => {
    if (!active || terminal) return Promise.resolve();
    clearTimer();
    if (running) { pending = true; return running; }
    if (!inCycle) { attempts = 0; inCycle = true; onStatus('pending'); }
    running = (async () => {
      pending = false;
      attempts += 1;
      controller = new AbortController();
      try {
        const payment = await verify(controller.signal);
        if (!active) return;
        if (payment.status === 'succeeded' || payment.status === 'failed') {
          terminal = true;
          onStatus(payment.status === 'succeeded' ? 'paid' : 'failed', payment);
        }
      } catch { /* Retry transient HTTP errors within the same finite budget. */ }
    })().finally(() => {
      running = null;
      controller = null;
      if (!active || terminal) return;
      if (attempts > delays.length) {
        inCycle = false;
        pending = false;
        onStatus('unknown');
        return;
      }
      timer = setTimeout(() => { void check(); }, pending ? 0 : delays[attempts - 1]);
    });
    return running;
  };
  return {
    check,
    recheck() {
      // Reconnect/event-driven verification also rechecks a previously final
      // result. Only automatic retries stop at a terminal HTTP response.
      if (terminal) { terminal = false; inCycle = false; }
      return check();
    },
    dispose() { active = false; clearTimer(); controller?.abort(); },
  };
}
