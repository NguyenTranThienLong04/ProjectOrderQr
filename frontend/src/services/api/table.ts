import { axiosClient } from './axios-client';

export interface Table {
  _id: string;
  tableCode: string;
  status: 'available' | 'occupied' | 'waiting_payment' | 'hidden';
  qrCodeUrl: string;
  currentSessionId?: string | null;
  groupedWithTableIds?: string[];
  capacity: number;
  createdAt?: string;
  updatedAt?: string;
}

export const tableApi = {
  findAll: async (): Promise<Table[]> => {
    const response = await axiosClient.get<Table[]>('/tables');
    return response.data;
  },

  findOne: async (id: string): Promise<Table> => {
    const response = await axiosClient.get<Table>(`/tables/${id}`);
    return response.data;
  },

  create: async (data: Omit<Table, '_id' | 'qrCodeUrl' | 'createdAt' | 'updatedAt'>): Promise<Table> => {
    const response = await axiosClient.post<Table>('/tables', data);
    return response.data;
  },

  update: async (id: string, data: Partial<Table>): Promise<Table> => {
    const response = await axiosClient.put<Table>(`/tables/${id}`, data);
    return response.data;
  },

  remove: async (id: string): Promise<{ success: boolean; message: string }> => {
    const response = await axiosClient.delete<{ success: boolean; message: string }>(`/tables/${id}`);
    return response.data;
  },

  regenerateQr: async (id: string): Promise<Table> => {
    const response = await axiosClient.post<Table>(`/tables/${id}/regenerate-qr`);
    return response.data;
  },
  clear: async (id: string): Promise<Table> => {
    const response = await axiosClient.patch<Table>(`/tables/${id}/clear`);
    return response.data;
  },
};
