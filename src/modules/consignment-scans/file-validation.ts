/**
 * Server-side checks for uploaded scan documents. The type is decided by the file's own bytes (magic numbers and, for
 * Office files, the package's part names) and must agree with the declared MIME type. Anything else is rejected:
 * source code, executables, archives, macro-enabled Office files.
 */
import { inflateRawSync } from 'node:zlib';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_SCAN = 12;

export type ScanFileType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const DOCX: ScanFileType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX: ScanFileType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Declared MIME types each detected type may arrive as (browsers label HEIC inconsistently). */
const ACCEPTED_DECLARED: Record<ScanFileType, string[]> = {
  'image/jpeg': ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  'image/png': ['image/png'],
  'image/webp': ['image/webp'],
  'image/heic': ['image/heic', 'image/heif', 'image/heic-sequence', 'application/octet-stream'],
  'application/pdf': ['application/pdf'],
  [DOCX]: [DOCX],
  [XLSX]: [XLSX],
};

const startsWith = (buf: Buffer, bytes: number[], offset = 0) => bytes.every((b, i) => buf[offset + i] === b);
const ascii = (buf: Buffer, start: number, end: number) => buf.subarray(start, end).toString('latin1');

/** ZIP entry names from the central directory (stored uncompressed), without trusting local headers. */
export function zipEntryNames(buf: Buffer): string[] {
  return zipEntries(buf).map((e) => e.name);
}

interface ZipEntry { name: string; method: number; compressedSize: number; localOffset: number }

function zipEntries(buf: Buffer): ZipEntry[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > buf.length) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; i += 1) {
    const nameLength = buf.readUInt16LE(p + 28);
    entries.push({
      method: buf.readUInt16LE(p + 10), compressedSize: buf.readUInt32LE(p + 20), localOffset: buf.readUInt32LE(p + 42),
      name: ascii(buf, p + 46, p + 46 + nameLength),
    });
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

/** One entry's bytes (stored or deflated), capped so a zip bomb cannot exhaust memory. */
export function zipEntry(buf: Buffer, name: string, maxBytes = 5 * 1024 * 1024): Buffer | null {
  const entry = zipEntries(buf).find((e) => e.name === name);
  if (!entry || buf.readUInt32LE(entry.localOffset) !== 0x04034b50) return null;
  const start = entry.localOffset + 30 + buf.readUInt16LE(entry.localOffset + 26) + buf.readUInt16LE(entry.localOffset + 28);
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) return null;
  return inflateRawSync(raw, { maxOutputLength: maxBytes });
}

function officeType(buf: Buffer): ScanFileType | 'MACRO' | null {
  const names = zipEntryNames(buf);
  if (names.some((n) => /vbaProject\.bin$/i.test(n) || /^(word|xl)\/(activeX|embeddings)\//i.test(n))) return 'MACRO';
  const types = zipEntry(buf, '[Content_Types].xml')?.toString('utf8') ?? '';
  if (/macroEnabled/i.test(types)) return 'MACRO';
  if (names.includes('word/document.xml')) return DOCX;
  if (names.includes('xl/workbook.xml')) return XLSX;
  return null;
}

/** The real type of the bytes, or null when it is not one of the accepted document types. */
export function detectType(buf: Buffer): ScanFileType | 'MACRO' | null {
  if (buf.length < 12) return null;
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(buf, 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(ascii(buf, 8, 12))) return 'image/heic';
  if (ascii(buf, 0, 5) === '%PDF-') return 'application/pdf';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return officeType(buf);
  return null;
}

export type FileCheck = { ok: true; type: ScanFileType } | { ok: false; reason: string };

/** Size, real type, declared type and (for PDF) no embedded scripts. */
export function checkUpload(buf: Buffer, declaredMime: string): FileCheck {
  if (buf.length === 0) return { ok: false, reason: 'The file is empty.' };
  if (buf.length > MAX_FILE_BYTES) return { ok: false, reason: `The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.` };
  const type = detectType(buf);
  if (type === 'MACRO') return { ok: false, reason: 'Macro-enabled Office files are not accepted.' };
  if (!type) return { ok: false, reason: 'Only photos (JPG, PNG, WEBP, HEIC), PDF, DOCX and XLSX files are accepted.' };
  if (!ACCEPTED_DECLARED[type].includes(declaredMime.toLowerCase())) return { ok: false, reason: 'The file type does not match its contents.' };
  if (type === 'application/pdf' && /\/(JavaScript|JS|Launch|EmbeddedFile)\b/.test(buf.toString('latin1'))) {
    return { ok: false, reason: 'PDFs with scripts or embedded files are not accepted.' };
  }
  return { ok: true, type };
}

/** Drops tags in one linear pass (no backtracking regex on untrusted XML), then decodes the five XML entities. */
const stripTags = (xml: string) => xml.split('<').map((part, i) => (i === 0 ? part : part.slice(part.indexOf('>') + 1))).join('');
const xmlText = (xml: string) => stripTags(xml).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Plain text of a DOCX (one line per paragraph) or XLSX (tab-separated rows of every sheet), for the model to read. */
export function officeText(buf: Buffer, type: ScanFileType): string {
  if (type === DOCX) {
    const doc = zipEntry(buf, 'word/document.xml')?.toString('utf8') ?? '';
    return doc.split(/<\/w:p>/).map((p) => xmlText(p.replace(/<w:tab\/>/g, '\t'))).filter((p) => p.trim()).join('\n');
  }
  const shared = [...(zipEntry(buf, 'xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1] ?? ''));
  const sheets = zipEntryNames(buf).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return sheets.map((name) => {
    const xml = zipEntry(buf, name)?.toString('utf8') ?? '';
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) => [...(row[1] ?? '').matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((cell) => {
      const value = xmlText(/<v>([\s\S]*?)<\/v>/.exec(cell[2] ?? '')?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[2] ?? '')?.[1] ?? '');
      return /t="s"/.test(cell[1] ?? '') ? (shared[Number(value)] ?? '') : value;
    }).join('\t'));
    return `# ${name.replace(/^xl\/worksheets\//, '')}\n${rows.join('\n')}`;
  }).join('\n\n');
}
