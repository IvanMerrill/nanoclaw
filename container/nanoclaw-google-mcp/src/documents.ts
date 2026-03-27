// Documents tool: local file text extraction (no network, no LLM)

import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_OUTPUT_CHARS = 20_000;
const MAX_PDF_PAGES = 100;

const ALLOWED_PREFIXES = [
  '/workspace/group/attachments/',
  '/workspace/group/drive-exports/',
];

export interface ReadDocumentResult {
  content: string;
  truncated: boolean;
  pageCount?: number;
  sheetNames?: string[];
}

/**
 * Validate that the resolved, symlink-followed path is inside an allowed directory.
 * `allowedPrefixes` is injectable for testing.
 */
export function validatePath(
  inputPath: string,
  allowedPrefixes: string[] = ALLOWED_PREFIXES,
): string {
  const resolved = path.resolve(inputPath);

  // First check before symlink resolution
  if (!allowedPrefixes.some((p) => resolved.startsWith(p))) {
    throw new Error('Access denied: path outside permitted directories.');
  }

  // Resolve symlinks and check again
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    // If file doesn't exist, realpathSync throws — that's fine,
    // we'll let the caller handle the missing file error
    // But we already validated the resolved path above
    return resolved;
  }

  if (!allowedPrefixes.some((p) => real.startsWith(p))) {
    throw new Error('Access denied: path outside permitted directories.');
  }

  return real;
}

function truncate(text: string): { content: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { content: text, truncated: false };
  }
  return {
    content: text.slice(0, MAX_OUTPUT_CHARS) + '\n[truncated at 20,000 chars]',
    truncated: true,
  };
}

// ---------- Parsers ----------

async function readPlainText(filePath: string): Promise<ReadDocumentResult> {
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  return { ...truncate(raw) };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function readHtml(filePath: string): Promise<ReadDocumentResult> {
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  const stripped = raw.replace(/<[^>]*>/g, '');
  const decoded = decodeHtmlEntities(stripped);
  return { ...truncate(decoded) };
}

async function readPdf(filePath: string): Promise<ReadDocumentResult> {
  // pdfjs-dist ships a Node-compatible build
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const data = new Uint8Array(await fs.promises.readFile(filePath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;

  const totalPages = doc.numPages;
  const pagesToRead = Math.min(totalPages, MAX_PDF_PAGES);
  const parts: string[] = [];

  for (let i = 1; i <= pagesToRead; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const pageText = tc.items
      .filter((item: Record<string, unknown>): boolean => 'str' in item)
      .map((item: Record<string, unknown>) => item.str as string)
      .join(' ');
    parts.push(pageText);
  }

  if (totalPages > MAX_PDF_PAGES) {
    parts.push(`\n[skipped pages ${MAX_PDF_PAGES + 1}-${totalPages} (max ${MAX_PDF_PAGES} pages)]`);
  }

  const joined = parts.join('\n');
  return { ...truncate(joined), pageCount: totalPages };
}

async function readDocx(filePath: string): Promise<ReadDocumentResult> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return { ...truncate(result.value) };
}

async function readXlsx(filePath: string): Promise<ReadDocumentResult> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.readFile(filePath);
  const sheetNames = workbook.SheetNames;
  const parts: string[] = [];

  for (const name of sheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    parts.push(`--- Sheet: ${name} ---`);
    parts.push(XLSX.utils.sheet_to_csv(sheet));
  }

  const joined = parts.join('\n');
  return { ...truncate(joined), sheetNames };
}

async function readPptx(filePath: string): Promise<ReadDocumentResult> {
  // PPTX files are ZIP archives. We use the xlsx library's zip utilities
  // to extract slide XML and parse <a:t> text tags.
  const XLSX = await import('xlsx');
  const { readFileSync } = fs;
  const data = readFileSync(filePath);
  const zip = XLSX.read(data, { type: 'buffer', bookSheets: true });

  // xlsx exposes the zip object via the internal "Sheets" but we need raw zip access.
  // Instead, use Node's built-in zlib with a lightweight zip reader approach.
  const { Readable } = await import('node:stream');
  const { createInflateRaw } = await import('node:zlib');

  // Manual ZIP parsing for slide XML extraction
  const texts = await extractPptxTexts(data);
  const joined = texts.join('\n');

  // Suppress unused variable lint — we needed the import for type resolution
  void zip;
  void Readable;
  void createInflateRaw;

  return { ...truncate(joined) };
}

/**
 * Minimal ZIP parser that finds ppt/slides/slide*.xml entries and extracts <a:t> text.
 */
async function extractPptxTexts(buffer: Buffer): Promise<string[]> {
  const { inflateRawSync } = await import('node:zlib');

  const entries = parseZipCentralDirectory(buffer);
  // Sort slide entries numerically
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => {
      const numA = parseInt(a.name.match(/slide(\d+)/)?.[1] ?? '0');
      const numB = parseInt(b.name.match(/slide(\d+)/)?.[1] ?? '0');
      return numA - numB;
    });

  const texts: string[] = [];
  for (const entry of slideEntries) {
    const raw = extractZipEntry(buffer, entry, inflateRawSync);
    const xml = raw.toString('utf-8');
    // Extract text from <a:t>...</a:t> tags
    const matches = xml.match(/<a:t>([^<]*)<\/a:t>/g);
    if (matches) {
      const slideText = matches
        .map((m) => m.replace(/<\/?a:t>/g, ''))
        .join(' ');
      texts.push(slideText);
    }
  }
  return texts;
}

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
}

function parseZipCentralDirectory(buf: Buffer): ZipEntry[] {
  // Find End of Central Directory record (signature: 0x06054b50)
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Invalid ZIP: no EOCD found');

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdCount = buf.readUInt16LE(eocdOffset + 10);

  const entries: ZipEntry[] = [];
  let pos = cdOffset;

  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;

    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf-8');

    entries.push({ name, compressedSize, uncompressedSize, compressionMethod, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

function extractZipEntry(
  buf: Buffer,
  entry: ZipEntry,
  inflateRaw: (data: Buffer) => Buffer,
): Buffer {
  const pos = entry.localHeaderOffset;
  // Local file header: signature(4) + version(2) + flags(2) + method(2) + ...
  // filename length at offset 26, extra field length at offset 28
  const nameLen = buf.readUInt16LE(pos + 26);
  const extraLen = buf.readUInt16LE(pos + 28);
  const dataStart = pos + 30 + nameLen + extraLen;

  const compressedData = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    // Stored (no compression)
    return Buffer.from(compressedData);
  }
  // Deflated
  return inflateRaw(Buffer.from(compressedData));
}

// ---------- Main entry point ----------

export async function readDocument(
  args: { path: string },
  allowedPrefixes?: string[],
): Promise<ReadDocumentResult> {
  const filePath = validatePath(args.path, allowedPrefixes);

  // Check file exists and size
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`File not found: ${args.path}`);
  }

  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds 20MB limit`);
  }

  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case '.txt':
    case '.csv':
    case '.md':
      return readPlainText(filePath);

    case '.html':
    case '.htm':
      return readHtml(filePath);

    case '.pdf':
      return readPdf(filePath);

    case '.docx':
      return readDocx(filePath);

    case '.xlsx':
      return readXlsx(filePath);

    case '.pptx':
      return readPptx(filePath);

    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}
