import { io } from 'socket.io-client';
import { API_URL } from '../config/api-url';
import { authApi } from './api/auth';
import { menuApi } from './api/menu';
import { customerToken, isSessionUnavailable, saveCustomerGrant, type CustomerGrant } from './customer-access';

export function createStaffSocket() {
  let disposed = false;
  const socket = io(API_URL, {
    auth: (callback) => {
      // Reuse the existing HTTP client to refresh expired access tokens.
      void authApi.getProfile().then(() => { if (!disposed) callback({ token: localStorage.getItem('accessToken') }); })
        .catch(() => { if (!disposed) callback({ token: '' }); });
    },
  });
  const resume = () => { if (!disposed && !socket.connected) socket.connect(); };
  window.addEventListener('focus', resume);
  window.addEventListener('online', resume);
  const disconnect = socket.disconnect.bind(socket);
  socket.disconnect = () => {
    disposed = true;
    window.removeEventListener('focus', resume);
    window.removeEventListener('online', resume);
    return disconnect();
  };
  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') resume();
  });
  return socket;
}

export function createCustomerSocket(tableId: string, sessionId: string, onRecoveryError?: (error: unknown) => void) {
  let disposed = false;
  let currentTableId = tableId;
  let currentSessionId = sessionId;
  const socket = io(API_URL, {
    auth: (callback) => callback({ customerToken: customerToken(currentSessionId, currentTableId) }),
    reconnectionAttempts: 3,
  });
  let renewal: AbortController | null = null;
  let renewalAttempts = 0;
  let scopeGeneration = 0;
  let invalid = false;
  const resume = () => {
    if (!disposed && !invalid && !socket.connected) { renewalAttempts = 0; void renew(); }
  };
  window.addEventListener('focus', resume);
  window.addEventListener('online', resume);
  const disconnect = socket.disconnect.bind(socket);
  socket.disconnect = () => {
    disposed = true;
    renewal?.abort();
    window.removeEventListener('focus', resume);
    window.removeEventListener('online', resume);
    return disconnect();
  };
  socket.on('session:authorized', (grant: CustomerGrant) => {
    scopeGeneration += 1;
    renewal?.abort();
    saveCustomerGrant(grant);
    currentTableId = grant.tableId;
    currentSessionId = grant.sessionId;
  });
  let renewing = false;
  const renew = async () => {
    if (renewing || disposed || invalid || renewalAttempts >= 2) return;
    renewing = true;
    renewalAttempts += 1;
    const generation = scopeGeneration;
    renewal = new AbortController();
    try {
      const cart = await menuApi.getActiveSession(currentTableId, currentSessionId, renewal.signal);
      if (!disposed && generation === scopeGeneration && cart.sessionId === currentSessionId) socket.connect();
    } catch (error) {
      if (!disposed && generation === scopeGeneration) {
        invalid = isSessionUnavailable(error);
        if (invalid) disconnect();
        onRecoveryError?.(error);
      }
    }
    finally { renewing = false; }
  };
  socket.on('connect', () => { renewalAttempts = 0; });
  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') void renew();
  });
  socket.on('connect_error', () => { void renew(); });
  return socket;
}
