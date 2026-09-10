import { corsOrigins, frontendUrl, socketCorsOrigin } from './public-urls';

describe('public deployment URLs', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: 'test' };
    delete process.env.FRONTEND_URL;
    delete process.env.CORS_ORIGIN;
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('keeps local development defaults', () => {
    expect(frontendUrl()).toBe('http://localhost:5173');
    expect(corsOrigins()).toEqual(['http://localhost:5173']);
  });

  it('requires a frontend URL in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => frontendUrl()).toThrow('FRONTEND_URL');
  });

  it('normalizes the production frontend for CORS, QR and return links', () => {
    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_URL = ' https://frontend.example.invalid/// ';
    expect(frontendUrl()).toBe('https://frontend.example.invalid');
    expect(corsOrigins()).toEqual(['https://frontend.example.invalid']);
  });

  it('supports an explicit production and local origin allowlist', () => {
    process.env.CORS_ORIGIN =
      ' https://frontend.example.invalid/, http://localhost:5173/ ';
    expect(corsOrigins()).toEqual([
      'https://frontend.example.invalid',
      'http://localhost:5173',
    ]);
    const callback = jest.fn();
    socketCorsOrigin('https://frontend.example.invalid', callback);
    expect(callback).toHaveBeenLastCalledWith(null, true);
    socketCorsOrigin('https://untrusted.example.invalid', callback);
    expect(callback).toHaveBeenLastCalledWith(null, false);
    socketCorsOrigin(undefined, callback);
    expect(callback).toHaveBeenLastCalledWith(null, true);
  });

  it('resolves Socket.IO configuration after module import', () => {
    process.env.FRONTEND_URL = 'https://late-config.example.invalid';
    const callback = jest.fn();
    socketCorsOrigin(process.env.FRONTEND_URL, callback);
    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it.each(['*', 'https://frontend.example.invalid,*', ', ,'])(
    'rejects wildcard or empty allowlists: %s',
    (value) => {
      process.env.CORS_ORIGIN = value;
      expect(() => corsOrigins()).toThrow('CORS_ORIGIN');
    },
  );
});
