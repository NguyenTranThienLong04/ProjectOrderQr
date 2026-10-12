import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { registerHooks } from 'node:module';
import axios, { AxiosError } from 'axios';

// Replace only Vite's build-time URL module; exercise real Axios interceptors.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/config/api-url')) {
      return { url: 'data:text/javascript,export const API_URL = "http://auth.test";', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { axiosClient, clearAuthState, handleLogout } = await import('../src/services/api/axios-client.ts');
const { authApi } = await import('../src/services/api/auth.ts');
const currentUser = { id: 'staff-id', email: 'staff@test', role: 'waiter', fullName: 'Staff' };
const response = (config, data = {}) => ({ config, data, status: 200, statusText: 'OK', headers: {} });
const unauthorized = (config) => {
  throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, null, { ...response(config), status: 401 });
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function seed() {
  localStorage.setItem('accessToken', 'old-access');
  localStorage.setItem('refreshToken', 'old-refresh');
  localStorage.setItem('user', JSON.stringify({ ...currentUser, role: 'admin' }));
  axiosClient.defaults.headers.common.Authorization = 'Bearer old-access';
}
function assertCleared() {
  for (const key of ['accessToken', 'refreshToken', 'user']) assert.equal(localStorage.getItem(key), null);
  assert.equal(axiosClient.defaults.headers.common.Authorization, undefined);
  assert.equal(window.location.href, '/login');
}
beforeEach(() => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.window = { location: { pathname: '/admin', href: '/admin' } };
  clearAuthState();
  seed();
});

test('logout calls the backend and clears storage plus default/per-request Authorization', async () => {
  const calls = [];
  axiosClient.defaults.adapter = async (config) => {
    calls.push({ url: config.url, authorization: config.headers.get('Authorization') });
    return response(config);
  };
  await authApi.logout();
  assertCleared();
  await axiosClient.get('/public', { headers: { authorization: 'Bearer stale' } });
  assert.deepEqual(calls, [
    { url: '/auth/logout', authorization: 'Bearer old-access' },
    { url: '/public', authorization: undefined },
  ]);
});

test('logout clears local state/header even when the backend fails; layout handler also revokes', async () => {
  const networkError = new Error('offline');
  let calls = 0;
  axiosClient.defaults.adapter = async () => { calls += 1; throw networkError; };
  await assert.rejects(authApi.logout(), networkError);
  assertCleared();
  seed();
  handleLogout();
  await new Promise((done) => setImmediate(done));
  assert.equal(calls, 2);
  assertCleared();
});

test('logout with expired access refreshes once then revokes using the new access token', async () => {
  const headers = [];
  let refreshes = 0;
  axios.defaults.adapter = async (config) => {
    refreshes += 1;
    assert.equal(JSON.parse(config.data).refreshToken, 'old-refresh');
    return response(config, { accessToken: 'new-access', refreshToken: 'new-refresh', user: currentUser });
  };
  axiosClient.defaults.adapter = async (config) => {
    headers.push(config.headers.get('Authorization'));
    if (headers.length === 1) return unauthorized(config);
    return response(config);
  };
  await authApi.logout();
  assert.equal(refreshes, 1);
  assert.deepEqual(headers, ['Bearer old-access', 'Bearer new-access']);
  assertCleared();
});

test('late refresh response cannot restore auth after logout', async () => {
  const started = deferred();
  const release = deferred();
  axios.defaults.adapter = async (config) => {
    started.resolve();
    await release.promise;
    return response(config, { accessToken: 'new-access', refreshToken: 'new-refresh', user: currentUser });
  };
  axiosClient.defaults.adapter = async (config) =>
    config.url === '/auth/logout' ? response(config) : unauthorized(config);
  const pending = assert.rejects(axiosClient.get('/private'), /Authentication changed/);
  await started.promise;
  await authApi.logout();
  assertCleared();
  release.resolve();
  await pending;
  assertCleared();
});

test('concurrent 401 responses share one refresh and persist the current role', async () => {
  let refreshes = 0;
  const release = deferred();
  const started = deferred();
  axios.defaults.adapter = async (config) => {
    refreshes += 1;
    started.resolve();
    await release.promise;
    return response(config, { accessToken: 'new-access', refreshToken: 'new-refresh', user: currentUser });
  };
  axiosClient.defaults.adapter = async (config) =>
    config.headers.get('Authorization') === 'Bearer new-access' ? response(config) : unauthorized(config);
  const requests = Promise.all([
    axiosClient.get('/one', { headers: { authorization: 'Bearer old-access' } }),
    axiosClient.get('/two'),
  ]);
  await started.promise;
  release.resolve();
  await requests;
  assert.equal(refreshes, 1);
  assert.equal(localStorage.getItem('refreshToken'), 'new-refresh');
  assert.deepEqual(JSON.parse(localStorage.getItem('user')), currentUser);
});

test('missing refresh token does not leave the refresh queue stuck for a later login', async () => {
  localStorage.removeItem('refreshToken');
  axiosClient.defaults.adapter = async (config) =>
    config.headers.get('Authorization') === 'Bearer new-access' ? response(config) : unauthorized(config);
  await assert.rejects(axiosClient.get('/private'), /Missing refresh token/);
  assertCleared();
  seed();
  axios.defaults.adapter = async (config) => response(config, {
    accessToken: 'new-access', refreshToken: 'new-refresh', user: currentUser,
  });
  await axiosClient.get('/private');
  assert.equal(localStorage.getItem('accessToken'), 'new-access');
});
