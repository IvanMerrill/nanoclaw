import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OAuth2Client } from 'googleapis-common';

// Mock googleapis before importing gmail module
const mockGet = vi.fn();
const mockList = vi.fn();
const mockAttachmentsGet = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    gmail: () => ({
      users: {
        messages: {
          get: mockGet,
          list: mockList,
          modify: vi.fn(),
          batchModify: vi.fn(),
          send: vi.fn(),
          attachments: {
            get: mockAttachmentsGet,
          },
        },
        labels: {
          list: vi.fn(),
          create: vi.fn(),
        },
        drafts: {
          create: vi.fn(),
        },
      },
    }),
  },
}));

// Mock fs for downloadAttachment
vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

import { readEmail, downloadAttachment, sanitizeFilename, stripHtml, extractBody } from './gmail.js';

const fakeGetAuth = async () => ({} as OAuth2Client);

describe('readEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should strip HTML tags from HTML-only body', async () => {
    const htmlContent = '<html><body><h1>Hello</h1><p>This is a <b>test</b> email.</p><br/><div>Footer</div></body></html>';
    const base64Html = Buffer.from(htmlContent).toString('base64url');

    mockGet.mockResolvedValue({
      data: {
        id: 'msg1',
        threadId: 'thread1',
        snippet: 'Hello This is a test email.',
        payload: {
          mimeType: 'text/html',
          headers: [
            { name: 'Subject', value: 'Test Subject' },
            { name: 'From', value: 'sender@example.com' },
            { name: 'To', value: 'recipient@example.com' },
            { name: 'Date', value: 'Mon, 1 Jan 2026 00:00:00 +0000' },
          ],
          body: { data: base64Html },
          parts: undefined,
        },
      },
    });

    const result = await readEmail({ messageId: 'msg1' }, fakeGetAuth);

    expect(result.body).not.toContain('<');
    expect(result.body).not.toContain('>');
    expect(result.body).toContain('Hello');
    expect(result.body).toContain('test');
    expect(result.body).toContain('email');
    expect(result.truncated).toBe(false);
  });

  it('should truncate body at 8000 chars', async () => {
    const longText = 'A'.repeat(10000);
    const base64Text = Buffer.from(longText).toString('base64url');

    mockGet.mockResolvedValue({
      data: {
        id: 'msg2',
        threadId: 'thread2',
        snippet: '',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'Subject', value: 'Long Email' },
            { name: 'From', value: 'sender@example.com' },
            { name: 'To', value: 'recipient@example.com' },
            { name: 'Date', value: 'Mon, 1 Jan 2026 00:00:00 +0000' },
          ],
          body: { data: base64Text },
          parts: undefined,
        },
      },
    });

    const result = await readEmail({ messageId: 'msg2' }, fakeGetAuth);

    expect(result.body.length).toBe(8000);
    expect(result.truncated).toBe(true);
  });
});

describe('downloadAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject disallowed MIME types', async () => {
    mockGet.mockResolvedValue({
      data: {
        id: 'msg3',
        payload: {
          parts: [
            {
              filename: 'malware.exe',
              mimeType: 'application/x-msdownload',
              body: { attachmentId: 'att1', size: 1000 },
            },
          ],
        },
      },
    });

    await expect(
      downloadAttachment(
        { messageId: 'msg3', attachmentId: 'att1' },
        fakeGetAuth,
      ),
    ).rejects.toThrow('MIME type "application/x-msdownload" is not allowed');
  });
});

describe('sanitizeFilename', () => {
  it('should sanitize path traversal attempts', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('attachment_download');
  });

  it('should handle empty filename', () => {
    expect(sanitizeFilename('')).toBe('attachment_download');
    expect(sanitizeFilename(undefined)).toBe('attachment_download');
  });

  it('should reject filenames containing path separators (e.g. from script tags)', () => {
    // </script> contains '/' so it's rejected as a path separator
    const result = sanitizeFilename('<script>alert(1)</script>.txt');
    expect(result).toBe('attachment_download');
  });

  it('should strip special chars from filenames without path separators', () => {
    const result = sanitizeFilename('file (copy).txt');
    expect(result).not.toContain('(');
    expect(result).not.toContain(')');
    expect(result).toBe('filecopy.txt');
  });

  it('should collapse consecutive dots', () => {
    const result = sanitizeFilename('file...name.txt');
    expect(result).not.toContain('...');
    expect(result).toBe('file.name.txt');
  });

  it('should handle leading dots', () => {
    const result = sanitizeFilename('.hidden');
    expect(result).toBe('hidden');
  });
});

describe('stripHtml', () => {
  it('should decode HTML entities', () => {
    expect(stripHtml('&amp; &lt; &gt; &quot; &#39;')).toBe('& < > " \'');
  });

  it('should convert br tags to newlines', () => {
    expect(stripHtml('line1<br>line2<br/>line3')).toBe('line1\nline2\nline3');
  });
});

describe('extractBody', () => {
  it('should prefer text/plain over text/html', () => {
    const plainData = Buffer.from('Plain text body').toString('base64url');
    const htmlData = Buffer.from('<p>HTML body</p>').toString('base64url');

    const payload = {
      mimeType: 'multipart/alternative',
      body: {},
      parts: [
        { mimeType: 'text/plain', body: { data: plainData }, parts: undefined },
        { mimeType: 'text/html', body: { data: htmlData }, parts: undefined },
      ],
    };

    const result = extractBody(payload);
    expect(result.body).toBe('Plain text body');
  });

  it('should fall back to HTML if no plain text', () => {
    const htmlData = Buffer.from('<p>HTML only</p>').toString('base64url');

    const payload = {
      mimeType: 'multipart/alternative',
      body: {},
      parts: [
        { mimeType: 'text/html', body: { data: htmlData }, parts: undefined },
      ],
    };

    const result = extractBody(payload);
    expect(result.body).toContain('HTML only');
    expect(result.body).not.toContain('<p>');
  });
});
