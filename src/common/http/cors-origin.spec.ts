import { isAllowedCorsOrigin, isPrivateLanHost } from './cors-origin';

describe('isPrivateLanHost', () => {
  it.each(['localhost', '127.0.0.1', '::1', '192.168.4.117', '10.0.0.8', '172.16.1.2', 'mac.local'])(
    'accepts %s',
    (host) => expect(isPrivateLanHost(host)).toBe(true),
  );

  it.each(['example.com', '8.8.8.8', '172.15.0.1', '172.32.0.1'])('rejects %s', (host) => {
    expect(isPrivateLanHost(host)).toBe(false);
  });
});

describe('isAllowedCorsOrigin', () => {
  const allowlist = ['http://localhost:3000'];

  it('allows missing Origin (curl, same-origin, native clients)', () => {
    expect(isAllowedCorsOrigin(undefined, allowlist, 'production')).toBe(true);
  });

  it('allows an exact CORS_ORIGINS entry in production', () => {
    expect(isAllowedCorsOrigin('http://localhost:3000', allowlist, 'production')).toBe(true);
  });

  it('rejects an unknown origin in production', () => {
    expect(isAllowedCorsOrigin('http://192.168.4.117:3000', allowlist, 'production')).toBe(false);
  });

  it('allows a LAN Next.js origin in development', () => {
    expect(isAllowedCorsOrigin('http://192.168.4.117:3000', allowlist, 'development')).toBe(true);
  });

  it('rejects https and public hosts even in development', () => {
    expect(isAllowedCorsOrigin('https://192.168.4.117:3000', allowlist, 'development')).toBe(false);
    expect(isAllowedCorsOrigin('http://evil.example:3000', allowlist, 'development')).toBe(false);
  });
});
