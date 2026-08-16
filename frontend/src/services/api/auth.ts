import { axiosClient } from './axios-client';

export interface User {
  id: string;
  email: string;
  role: 'admin' | 'kitchen' | 'waiter';
  fullName: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export const authApi = {
  login: async (email: string, password: string): Promise<LoginResponse> => {
    const response = await axiosClient.post<LoginResponse>('/auth/login', { email, password });
    return response.data;
  },

  logout: async (): Promise<void> => {
    await axiosClient.post('/auth/logout');
  },

  getProfile: async (): Promise<{ user: User }> => {
    const response = await axiosClient.post('/auth/me');
    return response.data;
  },
  
  registerStaff: async (fullName: string, email: string, passwordPlain: string, role: string): Promise<any> => {
    const response = await axiosClient.post('/auth/register', {
      fullName,
      email,
      password: passwordPlain,
      role
    });
    return response.data;
  }
};
