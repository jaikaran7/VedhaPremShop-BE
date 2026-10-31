import { createHmac, timingSafeEqual } from 'node:crypto';

/** Document links live this long; the review screen re-reads the scan (and gets fresh links) well within it. */
export const FILE_LINK_TTL_SECONDS = 10 * 60;

/** A key used only for file links, derived from the server secret so the JWT secret itself never signs URLs. */
const linkKey = (secret: string): Buffer => createHmac('sha256', secret).update('consignment-scan-file-links').digest();
const sign = (secret: string, documentId: string, exp: number): string => createHmac('sha256', linkKey(secret)).update(`${documentId}.${exp}`).digest('base64url');

/** A short-lived link to one private document; the API serves it only while the signature and expiry hold. */
export function signedFilePath(secret: string, documentId: string, nowSeconds: number): string {
  const exp = nowSeconds + FILE_LINK_TTL_SECONDS;
  return `/consignment-scans/files/${documentId}?exp=${exp}&sig=${sign(secret, documentId, exp)}`;
}

export function verifyFileLink(secret: string, documentId: string, exp: number, sig: string, nowSeconds: number): boolean {
  if (exp < nowSeconds || exp > nowSeconds + FILE_LINK_TTL_SECONDS) return false;
  const expected = Buffer.from(sign(secret, documentId, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
