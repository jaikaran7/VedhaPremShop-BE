/** Loopback and RFC1918 hosts that Next.js serves on the same LAN in development. */
export function isPrivateLanHost(host: string): boolean {
  const hostname = host.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
    return true;
  }
  if (hostname.endsWith('.local')) return true;
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first = -1, second = -1] = octets;
  return first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
}

/**
 * Production uses CORS_ORIGINS only. Development also accepts http:// on this machine
 * or the private LAN so a phone can open the Next.js Network URL against this API.
 */
export function isAllowedCorsOrigin(
  origin: string | undefined,
  allowlist: string[],
  nodeEnv: 'development' | 'test' | 'production',
): boolean {
  if (!origin) return true;
  if (allowlist.includes(origin)) return true;
  if (nodeEnv === 'production') return false;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && isPrivateLanHost(url.hostname);
  } catch {
    return false;
  }
}
