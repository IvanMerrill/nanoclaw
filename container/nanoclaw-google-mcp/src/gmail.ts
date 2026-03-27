// Gmail tool implementations

import { google } from 'googleapis';
import type { OAuth2Client } from 'googleapis-common';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

type GetAuth = () => Promise<OAuth2Client>;

// ---------- Helpers ----------

function getHeader(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string,
): string {
  if (!headers) return '';
  const h = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function stripHtml(html: string): string {
  let text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  return text.trim();
}

function extractBody(
  payload: { mimeType?: string | null; body?: { data?: string | null }; parts?: unknown[] } | undefined,
): { body: string; truncated: boolean } {
  if (!payload) return { body: '', truncated: false };

  // Try to find text/plain first, then text/html
  const plainText = findMimePart(payload, 'text/plain');
  const htmlPart = findMimePart(payload, 'text/html');

  let body = '';
  if (plainText) {
    body = Buffer.from(plainText, 'base64url').toString('utf-8');
  } else if (htmlPart) {
    body = stripHtml(Buffer.from(htmlPart, 'base64url').toString('utf-8'));
  }

  const truncated = body.length > 8000;
  if (truncated) {
    body = body.slice(0, 8000);
  }
  return { body, truncated };
}

function findMimePart(
  part: { mimeType?: string | null; body?: { data?: string | null }; parts?: unknown[] },
  mimeType: string,
): string | null {
  if (part.mimeType === mimeType && part.body?.data) {
    return part.body.data;
  }
  if (Array.isArray(part.parts)) {
    for (const child of part.parts as Array<typeof part>) {
      const found = findMimePart(child, mimeType);
      if (found) return found;
    }
  }
  return null;
}

interface AttachmentInfo {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

function extractAttachments(
  payload: { parts?: unknown[] } | undefined,
): AttachmentInfo[] {
  if (!payload) return [];
  const attachments: AttachmentInfo[] = [];
  collectAttachments(payload as Record<string, unknown>, attachments);
  return attachments;
}

function collectAttachments(
  part: Record<string, unknown>,
  out: AttachmentInfo[],
): void {
  const body = part.body as { attachmentId?: string; size?: number } | undefined;
  if (body?.attachmentId && (part.filename as string)) {
    out.push({
      id: body.attachmentId,
      filename: part.filename as string,
      mimeType: (part.mimeType as string) ?? 'application/octet-stream',
      size: body.size ?? 0,
    });
  }
  if (Array.isArray(part.parts)) {
    for (const child of part.parts as Array<Record<string, unknown>>) {
      collectAttachments(child, out);
    }
  }
}

async function buildRawMessage(args: {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  htmlBody?: string;
  inReplyTo?: string;
}): Promise<string> {
  const mailOptions: Record<string, unknown> = {
    to: args.to.join(', '),
    subject: args.subject,
    text: args.body,
  };
  if (args.htmlBody) mailOptions.html = args.htmlBody;
  if (args.cc?.length) mailOptions.cc = args.cc.join(', ');
  if (args.bcc?.length) mailOptions.bcc = args.bcc.join(', ');
  if (args.inReplyTo) {
    mailOptions.inReplyTo = args.inReplyTo;
    mailOptions.references = args.inReplyTo;
  }

  const composer = new MailComposer(mailOptions);
  const message = await composer.compile().build();
  return Buffer.from(message).toString('base64url');
}

// ---------- Tool implementations ----------

export async function searchEmails(
  args: { query: string; maxResults?: number },
  getAuth: GetAuth,
) {
  const auth = await getAuth();
  const gmail = google.gmail({ version: 'v1', auth });
  const maxResults = Math.min(args.maxResults ?? 20, 100);

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: args.query,
    maxResults,
  });

  const messages = listRes.data.messages ?? [];
  if (messages.length === 0) return [];

  const results = await Promise.all(
    messages.map(async (msg) => {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });
      const headers = detail.data.payload?.headers as
        | Array<{ name?: string | null; value?: string | null }>
        | undefined;
      return {
        id: detail.data.id,
        threadId: detail.data.threadId,
        subject: getHeader(headers, 'Subject'),
        from: getHeader(headers, 'From'),
        date: getHeader(headers, 'Date'),
        snippet: detail.data.snippet ?? '',
      };
    }),
  );

  return results;
}

export async function readEmail(
  args: { messageId: string },
  getAuth: GetAuth,
) {
  const auth = await getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.get({
    userId: 'me',
    id: args.messageId,
    format: 'full',
  });

  const headers = res.data.payload?.headers as
    | Array<{ name?: string | null; value?: string | null }>
    | undefined;

  const { body, truncated } = extractBody(
    res.data.payload as Parameters<typeof extractBody>[0],
  );
  const attachments = extractAttachments(
    res.data.payload as Parameters<typeof extractAttachments>[0],
  );

  return {
    id: res.data.id,
    threadId: res.data.threadId,
    subject: getHeader(headers, 'Subject'),
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    date: getHeader(headers, 'Date'),
    body,
    truncated,
    hasAttachments: attachments.length > 0,
    attachments,
  };
}

export async function modifyEmail(
  args: { messageId: string; addLabelIds?: string[]; removeLabelIds?: string[] },
  getAuth: GetAuth,
) {
  const auth = await getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  await gmail.users.messages.modify({
    userId: 'me',
    id: args.messageId,
    requestBody: {
      addLabelIds: args.addLabelIds,
      removeLabelIds: args.removeLabelIds,
    },
  });

  return { success: true };
}

export async function batchModifyEmails(
  args: {
    messageIds: string[];
    addLabelIds?: string[];
    removeLabelIds?: string[];
    batchSize?: number;
  },
  getAuth: GetAuth,
) {
  const auth = await getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const ids = args.messageIds.slice(0, 200);
  const batchSize = args.batchSize ?? 50;
  let processed = 0;

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    try {
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: batch,
          addLabelIds: args.addLabelIds,
          removeLabelIds: args.removeLabelIds,
        },
      });
      processed += batch.length;
    } catch {
      // Fall back to individual modify calls
      for (const id of batch) {
        try {
          await gmail.users.messages.modify({
            userId: 'me',
            id,
            requestBody: {
              addLabelIds: args.addLabelIds,
              removeLabelIds: args.removeLabelIds,
            },
          });
          processed++;
        } catch {
          // Skip failures on individual messages
        }
      }
    }
  }

  return { success: true, processed };
}

export async function listEmailLabels(getAuth: GetAuth) {
  const auth = await getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.labels.list({ userId: 'me' });
  const labels = res.data.labels ?? [];

  return labels.map((l) => ({
    id: l.id,
    name: l.name,
    type: l.type,
  }));
}

export async function getOrCreateLabel(
  args: {
    name: string;
    labelListVisibility?: string;
    messageListVisibility?: string;
  },
  getAuth: GetAuth,
) {
  const auth = await getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  // Check if label exists
  const listRes = await gmail.users.labels.list({ userId: 'me' });
  const existing = (listRes.data.labels ?? []).find(
    (l) => l.name?.toLowerCase() === args.name.toLowerCase(),
  );
  if (existing) {
    return { id: existing.id, name: existing.name };
  }

  // Create new label
  const createRes = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: args.name,
      labelListVisibility: (args.labelListVisibility ?? 'labelShow') as
        | 'labelShow'
        | 'labelShowIfUnread'
        | 'labelHide',
      messageListVisibility: (args.messageListVisibility ?? 'show') as 'show' | 'hide',
    },
  });

  return { id: createRes.data.id, name: createRes.data.name };
}

export async function sendEmail(
  args: {
    to: string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
    htmlBody?: string;
    inReplyTo?: string;
    threadId?: string;
  },
  getAuth: GetAuth,
) {
  const auth = await getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const raw = await buildRawMessage(args);

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      threadId: args.threadId,
    },
  });

  return { success: true, messageId: res.data.id };
}

export async function draftEmail(
  args: {
    to: string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
    htmlBody?: string;
    inReplyTo?: string;
    threadId?: string;
  },
  getAuth: GetAuth,
) {
  const auth = await getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const raw = await buildRawMessage(args);

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw,
        threadId: args.threadId,
      },
    },
  });

  return { success: true, draftId: res.data.id };
}

// ---------- Download attachment ----------

const ALLOWED_MIME_TYPES = new Set([
  'text/plain',
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
]);

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB

export function sanitizeFilename(filename: string | undefined): string {
  let name = filename ?? '';
  // Reject path traversal (literal ".." path component) or directory separators
  if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(name) || name.includes('/') || name.includes('\\')) {
    return 'attachment_download';
  }
  // Strip anything not alphanumeric, dot, dash, underscore
  name = name.replace(/[^a-zA-Z0-9._-]/g, '');
  // Collapse consecutive dots
  name = name.replace(/\.{2,}/g, '.');
  // Remove leading dots
  name = name.replace(/^\.+/, '');
  if (!name) {
    name = 'attachment_download';
  }
  return name;
}

export async function downloadAttachment(
  args: { messageId: string; attachmentId: string; filename?: string },
  getAuth: GetAuth,
) {
  const auth = await getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  // Get message to find attachment metadata
  const msgRes = await gmail.users.messages.get({
    userId: 'me',
    id: args.messageId,
    format: 'full',
  });

  const attachments = extractAttachments(
    msgRes.data.payload as Parameters<typeof extractAttachments>[0],
  );
  const attachment = attachments.find((a) => a.id === args.attachmentId);

  if (!attachment) {
    throw new Error('Attachment not found');
  }

  // MIME type check
  if (!ALLOWED_MIME_TYPES.has(attachment.mimeType)) {
    throw new Error(
      `MIME type "${attachment.mimeType}" is not allowed. Allowed types: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
    );
  }

  // Size check (before downloading)
  if (attachment.size > MAX_ATTACHMENT_SIZE) {
    throw new Error(
      `Attachment size ${attachment.size} bytes exceeds maximum of ${MAX_ATTACHMENT_SIZE} bytes`,
    );
  }

  // Sanitize filename
  const safeName = sanitizeFilename(args.filename ?? attachment.filename);

  // Download attachment data
  const attRes = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId: args.messageId,
    id: args.attachmentId,
  });

  const data = attRes.data.data;
  if (!data) {
    throw new Error('No attachment data returned');
  }

  // Write to fixed output directory
  const outputDir = '/workspace/group/attachments';
  await fs.mkdir(outputDir, { recursive: true });
  const savedPath = path.join(outputDir, safeName);
  const buffer = Buffer.from(data, 'base64url');
  await fs.writeFile(savedPath, buffer);

  return { savedPath };
}

// Re-export helpers for testing
export { stripHtml, extractBody };
