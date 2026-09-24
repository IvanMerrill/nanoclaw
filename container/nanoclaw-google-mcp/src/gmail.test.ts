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

import { readEmail, downloadAttachment, sanitizeFilename, stripHtml, extractBody, isAllowedAttachment } from './gmail.js';

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

  it('downloads a PDF with explicit application/pdf MIME type', async () => {
    mockAttachmentsGet.mockResolvedValue({
      data: { data: Buffer.from('PDF content').toString('base64url') },
    });

    const result = await downloadAttachment(
      {
        messageId: 'msg1',
        attachmentId: 'att-abc',
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        size: 100,
      },
      fakeGetAuth,
    );

    expect(mockGet).not.toHaveBeenCalled(); // no re-fetch of message metadata
    expect(mockAttachmentsGet).toHaveBeenCalledWith({
      userId: 'me',
      messageId: 'msg1',
      id: 'att-abc',
    });
    expect(result.savedPath).toContain('invoice.pdf');
  });

  it('downloads a PDF labeled application/octet-stream using extension fallback', async () => {
    mockAttachmentsGet.mockResolvedValue({
      data: { data: Buffer.from('PDF content').toString('base64url') },
    });

    const result = await downloadAttachment(
      {
        messageId: 'msg1',
        attachmentId: 'att-abc',
        filename: 'Factuur_260813409.pdf',
        mimeType: 'application/octet-stream',
      },
      fakeGetAuth,
    );

    expect(result.savedPath).toContain('Factuur_260813409.pdf');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('downloads when mime_type is absent and filename has known extension', async () => {
    mockAttachmentsGet.mockResolvedValue({
      data: { data: Buffer.from('image data').toString('base64url') },
    });

    const result = await downloadAttachment(
      { messageId: 'msg1', attachmentId: 'att-abc', filename: 'photo.png' },
      fakeGetAuth,
    );

    expect(result.savedPath).toContain('photo.png');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('rejects disallowed explicit MIME types', async () => {
    await expect(
      downloadAttachment(
        {
          messageId: 'msg1',
          attachmentId: 'att1',
          filename: 'malware.exe',
          mimeType: 'application/x-msdownload',
        },
        fakeGetAuth,
      ),
    ).rejects.toThrow('MIME type "application/x-msdownload" is not allowed');

    expect(mockAttachmentsGet).not.toHaveBeenCalled();
  });

  it('rejects by pre-download size when size parameter is provided', async () => {
    await expect(
      downloadAttachment(
        {
          messageId: 'msg1',
          attachmentId: 'att1',
          filename: 'big.pdf',
          mimeType: 'application/pdf',
          size: 11 * 1024 * 1024, // 11MB > 10MB limit
        },
        fakeGetAuth,
      ),
    ).rejects.toThrow('exceeds maximum');

    expect(mockAttachmentsGet).not.toHaveBeenCalled();
  });

  it('rejects by post-download size when content exceeds limit', async () => {
    const bigBuffer = Buffer.alloc(11 * 1024 * 1024);
    mockAttachmentsGet.mockResolvedValue({
      data: { data: bigBuffer.toString('base64url') },
    });

    await expect(
      downloadAttachment(
        { messageId: 'msg1', attachmentId: 'att1', filename: 'big.pdf', mimeType: 'application/pdf' },
        fakeGetAuth,
      ),
    ).rejects.toThrow('too large');
  });

  it('surfaces Attachment not found when attachments.get returns 404', async () => {
    mockAttachmentsGet.mockRejectedValue(Object.assign(new Error('Not found'), { code: 404 }));

    await expect(
      downloadAttachment(
        { messageId: 'msg1', attachmentId: 'expired-id', filename: 'file.pdf', mimeType: 'application/pdf' },
        fakeGetAuth,
      ),
    ).rejects.toThrow('Attachment not found');
  });

  it('surfaces generic error from attachments.get', async () => {
    mockAttachmentsGet.mockRejectedValue(new Error('Network error'));

    await expect(
      downloadAttachment(
        { messageId: 'msg1', attachmentId: 'att1', filename: 'file.pdf', mimeType: 'application/pdf' },
        fakeGetAuth,
      ),
    ).rejects.toThrow('Failed to download attachment');
  });

  it('throws when attachments.get returns no data', async () => {
    mockAttachmentsGet.mockResolvedValue({ data: {} });

    await expect(
      downloadAttachment(
        { messageId: 'msg1', attachmentId: 'att1', filename: 'file.pdf', mimeType: 'application/pdf' },
        fakeGetAuth,
      ),
    ).rejects.toThrow('No attachment data returned');
  });
});

describe('isAllowedAttachment', () => {
  it('allows application/pdf directly', () => {
    expect(isAllowedAttachment('application/pdf', 'file.pdf')).toBe(true);
  });

  it('allows application/octet-stream PDF via extension fallback', () => {
    expect(isAllowedAttachment('application/octet-stream', 'invoice.pdf')).toBe(true);
  });

  it('allows absent MIME type with known extension', () => {
    expect(isAllowedAttachment(undefined, 'photo.png')).toBe(true);
  });

  it('rejects explicit disallowed MIME type regardless of extension', () => {
    expect(isAllowedAttachment('application/x-msdownload', 'file.pdf')).toBe(false);
  });

  it('rejects unknown extension with generic MIME type', () => {
    expect(isAllowedAttachment('application/octet-stream', 'script.sh')).toBe(false);
  });

  it('allows when no MIME type and no extension', () => {
    expect(isAllowedAttachment(undefined, 'attachment_download')).toBe(true);
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
