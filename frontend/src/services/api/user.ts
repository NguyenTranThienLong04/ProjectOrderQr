import { axiosClient } from './axios-client';

export type UserRole = 'admin' | 'kitchen' | 'waiter';

export interface ManagedUser {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
  isActive: boolean;
}

export interface UserPayload {
  fullName: string;
  email: string;
  password?: string;
  role: UserRole;
  isActive?: boolean;
}

export const userApi = {
  findAll: async (): Promise<ManagedUser[]> => (await axiosClient.get<ManagedUser[]>('/users')).data,
  create: async (data: UserPayload & { password: string }): Promise<ManagedUser> => (await axiosClient.post<ManagedUser>('/users', data)).data,
  update: async (id: string, data: Partial<UserPayload>): Promise<ManagedUser> => (await axiosClient.put<ManagedUser>(`/users/${id}`, data)).data,
  remove: async (id: string): Promise<{ success: boolean; message: string }> => (await axiosClient.delete<{ success: boolean; message: string }>(`/users/${id}`)).data,
};
