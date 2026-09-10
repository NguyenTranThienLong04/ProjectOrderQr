/** Public URL configuration shared by HTTP, Socket.IO, QR and browser returns. */
export function frontendUrl(value = process.env.FRONTEND_URL): string {
  const url = value?.trim().replace(/\/+$/, '');
  if (url) return url;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FRONTEND_URL is required in production');
  }
  return 'http://localhost:5173';
}

export function corsOrigins(): string[] {
  const origins = (process.env.CORS_ORIGIN?.trim() || frontendUrl())
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (origins.length === 0 || origins.includes('*')) {
    throw new Error('CORS_ORIGIN must contain explicit frontend origins');
  }
  return origins;
}

// Resolve at request time: gateway decorators can run before ConfigModule loads.
export function socketCorsOrigin(
  origin: string | undefined,
  callback: (error: Error | null, allowed: boolean) => void,
): void {
  callback(null, !origin || corsOrigins().includes(origin));
}
