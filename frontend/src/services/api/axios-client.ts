import axios from 'axios';

import { API_URL } from '../../config/api-url';

declare module 'axios' {
  interface AxiosRequestConfig {
    skipAuthRefresh?: boolean;
  }
}

export const axiosClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Interceptor for requests: attach access token
axiosClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    if (token && config.headers) {
      config.headers.set('Authorization', `Bearer ${token}`);
    } else {
      config.headers.delete('Authorization');
    }
    return config;
  },
  (error) => Promise.reject(error),
);

let authGeneration = 0;
let refreshPromise: Promise<string> | null = null;
let logoutPromise: Promise<void> | null = null;

export const clearAuthState = () => {
  authGeneration += 1;
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('user');
  delete axiosClient.defaults.headers.common.Authorization;
  delete axiosClient.defaults.headers.common.authorization;
  if (window.location.pathname !== '/login') window.location.href = '/login';
};

const refreshAccessToken = (): Promise<string> => {
  if (refreshPromise) return refreshPromise;
  const generation = authGeneration;
  const refreshToken = localStorage.getItem('refreshToken');
  refreshPromise = (async () => {
    try {
      if (!refreshToken) throw new Error('Missing refresh token');
      const response = await axios.post(`${API_URL}/auth/refresh`, { refreshToken }, { timeout: 10_000 });
      // Logout or another login must not be undone by a late refresh response.
      if (generation !== authGeneration || localStorage.getItem('refreshToken') !== refreshToken) {
        throw new Error('Authentication changed during refresh');
      }
      const { accessToken, refreshToken: nextRefreshToken, user } = response.data;
      localStorage.setItem('accessToken', accessToken);
      localStorage.setItem('refreshToken', nextRefreshToken);
      localStorage.setItem('user', JSON.stringify(user));
      return accessToken;
    } catch (error) {
      if (generation === authGeneration && localStorage.getItem('refreshToken') === refreshToken) {
        clearAuthState();
      }
      throw error;
    }
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
};

axiosClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Avoid infinite loop if auth/login or auth/refresh fails
    if (!originalRequest || originalRequest.skipAuthRefresh || originalRequest.url?.includes('/auth/login') || originalRequest.url?.includes('/auth/refresh')) {
      return Promise.reject(error);
    }

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      // A delayed 401 may belong to the access token already replaced by
      // another request. Reuse the current token before rotating again.
      let token = localStorage.getItem('accessToken');
      if (!token || originalRequest.headers.get('Authorization') === `Bearer ${token}`) {
        token = await refreshAccessToken();
      }
      originalRequest.headers.set('Authorization', `Bearer ${token}`);
      return axiosClient(originalRequest);
    }

    return Promise.reject(error);
  },
);

export const logoutAndClear = (): Promise<void> => {
  if (logoutPromise) return logoutPromise;
  logoutPromise = (async () => {
    try {
      // The normal interceptor can refresh an expired access token first.
      if (localStorage.getItem('accessToken') || localStorage.getItem('refreshToken')) {
        await axiosClient.post('/auth/logout', undefined, { timeout: 10_000 });
      }
    } finally {
      clearAuthState();
    }
  })().finally(() => { logoutPromise = null; });
  return logoutPromise;
};

// Existing layout effects/click handlers expect a synchronous void callback.
export const handleLogout = (): void => {
  void logoutAndClear().catch(() => { /* Local cleanup already ran in finally. */ });
};
