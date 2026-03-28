import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import mammoth from 'mammoth';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

export const MAX_EXTRACT_CHARS = 30_000;

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.xml',
  '.yaml',
  '.yml',
  '.log',
  '.py',
  '.js',
  '.ts',
  '.sh',
  '.html',
  '.css',
  '.env',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.sql',
]);

export function sanitizeFilename(name: string): string {
  let result = name
    .replace(/\0/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '');

  if (result.length > 100) {
    result = result.slice(0, 100);
  }

  return result || 'file';
}

export async function extractText(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();

  try {
    let text: string;

    if (TEXT_EXTENSIONS.has(ext)) {
      text = await fs.promises.readFile(filePath, 'utf-8');
    } else if (ext === '.pdf') {
      const { stdout } = await execFileAsync('pdftotext', [filePath, '-']);
      text = stdout;
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      text = result.value;
    } else {
      return null;
    }

    if (text.length > MAX_EXTRACT_CHARS) {
      return text.slice(0, MAX_EXTRACT_CHARS) + '\n[...truncated]';
    }

    return text;
  } catch (err) {
    logger.warn({ filePath, err }, 'Failed to extract text from file');
    return null;
  }
}

export function formatFileMessage(
  containerPath: string,
  extractedText: string | null,
  caption: string,
): string {
  if (extractedText) {
    return `[File: ${containerPath}]\n--- file contents ---\n${extractedText}\n--- end file contents ---${caption}`;
  }
  return `[File: ${containerPath}]${caption}`;
}
