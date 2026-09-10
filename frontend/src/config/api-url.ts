// Vite embeds this public URL at build time; HTTP and Socket.IO share it.
export const API_URL = (
  import.meta.env.VITE_API_URL?.trim() ||
  (import.meta.env.DEV ? 'http://localhost:3000' : '')
).replace(/\/+$/, '');
