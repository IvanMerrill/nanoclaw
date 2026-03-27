import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Mocks ---

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('mammoth', () => ({
  default: {
    extractRawText: vi.fn(),
  },
}));

import {
  sanitizeFilename,
  extractText,
  formatFileMessage,
  MAX_EXTRACT_CHARS,
} from './file-extract.js';

import { execFile } from 'child_process';
import mammoth from 'mammoth';

// --- Tests ---

describe('sanitizeFilename', () => {
  it('passes through clean filenames', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
  });

  it('strips path traversal', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('etc_passwd');
  });

  it('strips null bytes', () => {
    expect(sanitizeFilename('file\0name.txt')).toBe('filename.txt');
  });

  it('replaces special characters', () => {
    expect(sanitizeFilename('my file (1).pdf')).toBe('my_file_1_.pdf');
  });

  it('truncates long filenames', () => {
    const longName = 'a'.repeat(150) + '.txt';
    const result = sanitizeFilename(longName);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('returns fallback for empty result', () => {
    expect(sanitizeFilename('...')).toBe('file');
  });

  it('handles slashes', () => {
    expect(sanitizeFilename('path/to/file.txt')).toBe('path_to_file.txt');
  });
});

describe('extractText', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-extract-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads text files as UTF-8', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world', 'utf-8');

    const result = await extractText(filePath);
    expect(result).toBe('hello world');
  });

  it('calls pdftotext for PDF files', async () => {
    // Mock execFile via promisify — the module mocks child_process.execFile,
    // and promisify wraps it. We need to make the callback-style mock work.
    vi.mocked(execFile).mockImplementation(
      ((_cmd: any, _args: any, callback: any) => {
        callback(null, { stdout: 'pdf content', stderr: '' });
      }) as any,
    );

    const result = await extractText('/tmp/test.pdf');
    expect(result).toBe('pdf content');
    expect(execFile).toHaveBeenCalledWith(
      'pdftotext',
      ['/tmp/test.pdf', '-'],
      expect.any(Function),
    );
  });

  it('calls mammoth for DOCX files', async () => {
    vi.mocked(mammoth.extractRawText).mockResolvedValue({
      value: 'docx content',
      messages: [],
    });

    const result = await extractText('/tmp/test.docx');
    expect(result).toBe('docx content');
  });

  it('truncates text exceeding MAX_EXTRACT_CHARS', async () => {
    const filePath = path.join(tmpDir, 'big.txt');
    const bigContent = 'x'.repeat(40_000);
    fs.writeFileSync(filePath, bigContent, 'utf-8');

    const result = await extractText(filePath);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(MAX_EXTRACT_CHARS + '\n[...truncated]'.length);
    expect(result!.endsWith('\n[...truncated]')).toBe(true);
  });

  it('returns null for unsupported extensions', async () => {
    const result = await extractText('/tmp/test.zip');
    expect(result).toBeNull();
  });

  it('returns null when pdftotext fails', async () => {
    vi.mocked(execFile).mockImplementation(
      ((_cmd: any, _args: any, callback: any) => {
        callback(new Error('pdftotext not found'));
      }) as any,
    );

    const result = await extractText('/tmp/test.pdf');
    expect(result).toBeNull();
  });

  it('returns null when mammoth fails', async () => {
    vi.mocked(mammoth.extractRawText).mockRejectedValue(
      new Error('corrupt docx'),
    );

    const result = await extractText('/tmp/test.docx');
    expect(result).toBeNull();
  });
});

describe('formatFileMessage', () => {
  it('formats message with extracted text', () => {
    const result = formatFileMessage(
      '/workspace/group/files/tg_1_report.pdf',
      'hello world',
      '',
    );
    expect(result).toBe(
      '[File: /workspace/group/files/tg_1_report.pdf]\n--- file contents ---\nhello world\n--- end file contents ---',
    );
  });

  it('formats message with caption', () => {
    const result = formatFileMessage(
      '/workspace/group/files/tg_1_report.pdf',
      'hello',
      ' Check this',
    );
    expect(result).toBe(
      '[File: /workspace/group/files/tg_1_report.pdf]\n--- file contents ---\nhello\n--- end file contents --- Check this',
    );
  });

  it('formats message without extracted text', () => {
    const result = formatFileMessage(
      '/workspace/group/files/tg_1_data.xlsx',
      null,
      '',
    );
    expect(result).toBe('[File: /workspace/group/files/tg_1_data.xlsx]');
  });

  it('formats message without text but with caption', () => {
    const result = formatFileMessage(
      '/workspace/group/files/tg_1_data.xlsx',
      null,
      ' See attached',
    );
    expect(result).toBe(
      '[File: /workspace/group/files/tg_1_data.xlsx] See attached',
    );
  });
});
