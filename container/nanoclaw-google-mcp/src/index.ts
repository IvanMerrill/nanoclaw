/**
 * NanoClaw Google MCP Server
 * Provides Gmail, Calendar, Drive, Docs, Sheets, Slides, and Documents tools
 * via a stdio-based MCP server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OAuth2Client } from 'googleapis-common';
import {
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
} from './calendar.js';
import {
  searchEmails,
  readEmail,
  modifyEmail,
  batchModifyEmails,
  listEmailLabels,
  getOrCreateLabel,
  sendEmail,
  draftEmail,
  downloadAttachment,
} from './gmail.js';
import {
  listDriveFiles,
  exportDriveFile,
  uploadDriveFile,
  updateDriveFileContent,
} from './drive.js';
import { getDocMetadata, createDoc, updateDoc } from './docs.js';
import { listSheets, readSheetRange, createSpreadsheet, writeSheetRange } from './sheets.js';
import { getPresentationMetadata, createPresentation } from './slides.js';
import { readDocument } from './documents.js';

// ---------- Token management ----------

const NANOCLAW_GOOGLE_TOKEN_URL = process.env.NANOCLAW_GOOGLE_TOKEN_URL;

interface TokenEntry {
  access_token: string;
  expires_at: number;
}

interface TokenCache {
  readonly: TokenEntry | null;
  readwrite: TokenEntry | null;
}

const tokenCache: TokenCache = {
  readonly: null,
  readwrite: null,
};

export async function getToken(
  scope: 'readonly' | 'readwrite',
): Promise<{ access_token: string; expires_at: number } | string> {
  if (!NANOCLAW_GOOGLE_TOKEN_URL) {
    return 'NANOCLAW_GOOGLE_TOKEN_URL is not set';
  }

  const cached = tokenCache[scope];
  if (cached && cached.expires_at > Date.now() / 1000 + 30) {
    return { access_token: cached.access_token, expires_at: cached.expires_at };
  }

  try {
    const response = await fetch(NANOCLAW_GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope }),
    });

    if (!response.ok) {
      return `Token request failed: ${response.status} ${response.statusText}`;
    }

    const data = (await response.json()) as { access_token: string; expires_at: number };
    tokenCache[scope] = {
      access_token: data.access_token,
      expires_at: data.expires_at,
    };

    return { access_token: data.access_token, expires_at: data.expires_at };
  } catch (err) {
    return `Token request error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function getGoogleAuth(
  scope: 'readonly' | 'readwrite',
): Promise<OAuth2Client | string> {
  const token = await getToken(scope);
  if (typeof token === 'string') {
    return token;
  }

  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: token.access_token });
  return auth;
}

// ---------- Tool scope map ----------

export const TOOL_SCOPES: Record<string, 'readonly' | 'readwrite' | 'none'> = {
  // Gmail
  search_emails: 'readonly',
  read_email: 'readonly',
  modify_email: 'readwrite',
  batch_modify_emails: 'readwrite',
  list_email_labels: 'readonly',
  get_or_create_label: 'readwrite',
  send_email: 'readwrite',
  draft_email: 'readwrite',
  download_attachment: 'readwrite',
  // Calendar
  list_events: 'readonly',
  get_event: 'readonly',
  create_event: 'readwrite',
  update_event: 'readwrite',
  delete_event: 'readwrite',
  // Drive
  list_drive_files: 'readonly',
  export_drive_file: 'readonly',
  upload_drive_file: 'readwrite',
  update_drive_file_content: 'readwrite',
  // Docs
  get_doc_metadata: 'readonly',
  create_doc: 'readwrite',
  update_doc: 'readwrite',
  // Sheets
  list_sheets: 'readonly',
  read_sheet_range: 'readonly',
  create_spreadsheet: 'readwrite',
  write_sheet_range: 'readwrite',
  // Slides
  get_presentation_metadata: 'readonly',
  create_presentation: 'readwrite',
  // Documents
  read_document: 'none',
};

// ---------- Handler helpers ----------

async function gmailHandler<T>(
  toolName: string,
  fn: (getAuth: () => Promise<OAuth2Client>) => Promise<T>,
) {
  const scope = TOOL_SCOPES[toolName] as 'readonly' | 'readwrite';
  const authGetter = async () => {
    const auth = await getGoogleAuth(scope);
    if (typeof auth === 'string') throw new Error(auth);
    return auth;
  };
  try {
    const result = await fn(authGetter);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

// ---------- MCP Server ----------

const server = new McpServer({
  name: 'google',
  version: '1.0.0',
});

// ===== Gmail Tools =====

server.tool(
  'search_emails',
  'Search Gmail messages using Gmail search syntax (e.g., "from:alice subject:report after:2024/01/01"). Returns message summaries.',
  {
    query: z.string().describe('Gmail search query (same syntax as Gmail search bar)'),
    max_results: z.number().optional().default(20).describe('Maximum number of results to return (default 20)'),
  },
  async (args) =>
    gmailHandler('search_emails', (getAuth) =>
      searchEmails({ query: args.query, maxResults: args.max_results }, getAuth),
    ),
);

server.tool(
  'read_email',
  'Read a specific email message by ID. Returns full content including headers, body, and attachment metadata.',
  {
    message_id: z.string().describe('The Gmail message ID'),
    format: z.enum(['full', 'metadata', 'minimal']).optional().default('full').describe('Response format (default full)'),
  },
  async (args) =>
    gmailHandler('read_email', (getAuth) =>
      readEmail({ messageId: args.message_id }, getAuth),
    ),
);

server.tool(
  'modify_email',
  'Modify a Gmail message: add/remove labels, mark as read/unread, archive, trash, or star.',
  {
    message_id: z.string().describe('The Gmail message ID'),
    add_labels: z.array(z.string()).optional().describe('Label names or IDs to add'),
    remove_labels: z.array(z.string()).optional().describe('Label names or IDs to remove'),
  },
  async (args) =>
    gmailHandler('modify_email', (getAuth) =>
      modifyEmail(
        { messageId: args.message_id, addLabelIds: args.add_labels, removeLabelIds: args.remove_labels },
        getAuth,
      ),
    ),
);

server.tool(
  'batch_modify_emails',
  'Apply the same label/modification to multiple Gmail messages at once.',
  {
    message_ids: z.array(z.string()).describe('Array of Gmail message IDs'),
    add_labels: z.array(z.string()).optional().describe('Label names or IDs to add'),
    remove_labels: z.array(z.string()).optional().describe('Label names or IDs to remove'),
  },
  async (args) =>
    gmailHandler('batch_modify_emails', (getAuth) =>
      batchModifyEmails(
        { messageIds: args.message_ids, addLabelIds: args.add_labels, removeLabelIds: args.remove_labels },
        getAuth,
      ),
    ),
);

server.tool(
  'list_email_labels',
  'List all Gmail labels for the authenticated user.',
  {},
  async () =>
    gmailHandler('list_email_labels', (getAuth) => listEmailLabels(getAuth)),
);

server.tool(
  'get_or_create_label',
  'Get an existing Gmail label by name, or create it if it does not exist. Returns the label ID.',
  {
    name: z.string().describe('Label name (e.g., "Projects/Active")'),
  },
  async (args) =>
    gmailHandler('get_or_create_label', (getAuth) =>
      getOrCreateLabel({ name: args.name }, getAuth),
    ),
);

server.tool(
  'send_email',
  'Send an email via Gmail. Supports plain text and HTML bodies, CC, BCC, and reply-to threading.',
  {
    to: z.string().describe('Recipient email address(es), comma-separated'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body (plain text)'),
    html: z.string().optional().describe('Email body (HTML, overrides plain text if provided)'),
    cc: z.string().optional().describe('CC recipients, comma-separated'),
    bcc: z.string().optional().describe('BCC recipients, comma-separated'),
    in_reply_to: z.string().optional().describe('Message-ID header of the email being replied to'),
    thread_id: z.string().optional().describe('Gmail thread ID to place this message in'),
  },
  async (args) =>
    gmailHandler('send_email', (getAuth) =>
      sendEmail(
        {
          to: args.to.split(',').map((s) => s.trim()),
          subject: args.subject,
          body: args.body,
          htmlBody: args.html,
          cc: args.cc?.split(',').map((s) => s.trim()),
          bcc: args.bcc?.split(',').map((s) => s.trim()),
          inReplyTo: args.in_reply_to,
          threadId: args.thread_id,
        },
        getAuth,
      ),
    ),
);

server.tool(
  'draft_email',
  'Create an email draft in Gmail without sending it.',
  {
    to: z.string().describe('Recipient email address(es), comma-separated'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body (plain text)'),
    html: z.string().optional().describe('Email body (HTML)'),
    cc: z.string().optional().describe('CC recipients, comma-separated'),
    bcc: z.string().optional().describe('BCC recipients, comma-separated'),
    in_reply_to: z.string().optional().describe('Message-ID of the email being replied to'),
    thread_id: z.string().optional().describe('Gmail thread ID'),
  },
  async (args) =>
    gmailHandler('draft_email', (getAuth) =>
      draftEmail(
        {
          to: args.to.split(',').map((s) => s.trim()),
          subject: args.subject,
          body: args.body,
          htmlBody: args.html,
          cc: args.cc?.split(',').map((s) => s.trim()),
          bcc: args.bcc?.split(',').map((s) => s.trim()),
          inReplyTo: args.in_reply_to,
          threadId: args.thread_id,
        },
        getAuth,
      ),
    ),
);

server.tool(
  'download_attachment',
  'Download an email attachment by message ID and attachment ID. Returns the file content as base64.',
  {
    message_id: z.string().describe('The Gmail message ID'),
    attachment_id: z.string().describe('The attachment ID from the message metadata'),
    filename: z.string().optional().describe('Suggested filename for the attachment'),
  },
  async (args) =>
    gmailHandler('download_attachment', (getAuth) =>
      downloadAttachment(
        { messageId: args.message_id, attachmentId: args.attachment_id, filename: args.filename },
        getAuth,
      ),
    ),
);

// ===== Calendar Tools =====

server.tool(
  'list_events',
  'List calendar events within a time range. Operates on the primary calendar.',
  {
    time_min: z.string().optional().describe('Start of time range (ISO 8601, e.g., "2026-01-01T00:00:00Z")'),
    time_max: z.string().optional().describe('End of time range (ISO 8601)'),
    max_results: z.number().optional().default(50).describe('Maximum number of events (default 50)'),
    query: z.string().optional().describe('Free-text search query for events'),
  },
  async (args) => {
    try {
      const result = await listEvents(args, () => getGoogleAuth('readonly'));
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'get_event',
  'Get a specific calendar event by ID.',
  {
    event_id: z.string().describe('The event ID'),
  },
  async (args) => {
    try {
      const result = await getEvent(args, () => getGoogleAuth('readonly'));
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'create_event',
  'Create a new calendar event with title, time, attendees, and optional description.',
  {
    summary: z.string().describe('Event title'),
    start: z.string().describe('Start time (ISO 8601, e.g., "2026-03-26T10:00:00-04:00")'),
    end: z.string().describe('End time (ISO 8601)'),
    description: z.string().optional().describe('Event description'),
    location: z.string().optional().describe('Event location'),
    attendees: z.array(z.string()).optional().describe('Attendee email addresses'),
    timezone: z.string().optional().describe('Timezone (e.g., "America/New_York")'),
  },
  async (args) => {
    try {
      const result = await createEvent(args, () => getGoogleAuth('readwrite'));
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'update_event',
  'Update an existing calendar event. Only provided fields are changed.',
  {
    event_id: z.string().describe('The event ID to update'),
    summary: z.string().optional().describe('New event title'),
    start: z.string().optional().describe('New start time (ISO 8601)'),
    end: z.string().optional().describe('New end time (ISO 8601)'),
    description: z.string().optional().describe('New event description'),
    location: z.string().optional().describe('New event location'),
    attendees: z.array(z.string()).optional().describe('New attendee list (replaces existing)'),
  },
  async (args) => {
    try {
      const result = await updateEvent(args, () => getGoogleAuth('readwrite'));
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'delete_event',
  'Delete a calendar event by ID.',
  {
    event_id: z.string().describe('The event ID to delete'),
  },
  async (args) => {
    try {
      const result = await deleteEvent(args, () => getGoogleAuth('readwrite'));
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ===== Drive Tools =====

server.tool(
  'list_drive_files',
  'List files in Google Drive. Supports Drive query syntax and ordering.',
  {
    query: z.string().optional().describe('Drive search query (e.g., "name contains \'report\'" or "mimeType=\'application/pdf\'")'),
    max_results: z.number().optional().default(20).describe('Maximum results (default 20, max 100)'),
    order_by: z.string().optional().describe('Sort order (e.g., "modifiedTime desc", "name")'),
  },
  async (args) => listDriveFiles(args, getGoogleAuth),
);

server.tool(
  'export_drive_file',
  'Export/download a Google Drive file. Google Workspace files (Docs, Sheets, Slides) are converted to text/CSV. PDF, DOCX, XLSX are downloaded as binary. Saved to /workspace/group/drive-exports/.',
  {
    file_id: z.string().describe('The Drive file ID'),
    filename: z.string().optional().describe('Custom output filename (sanitized). If omitted, uses the Drive file name.'),
  },
  async (args) => exportDriveFile(args, getGoogleAuth),
);

server.tool(
  'upload_drive_file',
  'Upload a new text file to Google Drive. Always creates a new file, never overwrites.',
  {
    name: z.string().describe('Filename in Drive'),
    content: z.string().describe('File content (text)'),
    mime_type: z.string().optional().default('text/plain').describe('MIME type (default text/plain)'),
    folder_id: z.string().optional().describe('Parent folder ID in Drive'),
  },
  async (args) => uploadDriveFile(args, getGoogleAuth),
);

server.tool(
  'update_drive_file_content',
  'Update the content of an existing Google Drive file.',
  {
    file_id: z.string().describe('The Drive file ID to update'),
    content: z.string().describe('New file content (text)'),
    mime_type: z.string().optional().describe('MIME type (if changing)'),
  },
  async (args) => updateDriveFileContent(args, getGoogleAuth),
);

// ===== Docs Tools =====

server.tool(
  'get_doc_metadata',
  'Get metadata for a Google Doc (title, last modified, etc.).',
  {
    document_id: z.string().describe('The Google Docs document ID'),
  },
  async (args) =>
    gmailHandler('get_doc_metadata', (getAuth) =>
      getDocMetadata({ document_id: args.document_id }, getAuth),
    ),
);

server.tool(
  'create_doc',
  'Create a new Google Doc with initial content.',
  {
    title: z.string().describe('Document title'),
  },
  async (args) =>
    gmailHandler('create_doc', (getAuth) =>
      createDoc({ title: args.title }, getAuth),
    ),
);

server.tool(
  'update_doc',
  'Insert text into a Google Doc.',
  {
    document_id: z.string().describe('The Google Docs document ID'),
    text: z.string().describe('Text content to insert'),
    insert_at_start: z.boolean().optional().describe('If true, insert at the beginning of the document instead of the end'),
  },
  async (args) =>
    gmailHandler('update_doc', (getAuth) =>
      updateDoc(
        { document_id: args.document_id, text: args.text, insert_at_start: args.insert_at_start },
        getAuth,
      ),
    ),
);

// ===== Sheets Tools =====

server.tool(
  'list_sheets',
  'List all sheets (tabs) in a Google Spreadsheet.',
  {
    spreadsheet_id: z.string().describe('The Google Sheets spreadsheet ID'),
  },
  async (args) =>
    gmailHandler('list_sheets', (getAuth) =>
      listSheets({ spreadsheet_id: args.spreadsheet_id }, getAuth),
    ),
);

server.tool(
  'read_sheet_range',
  'Read data from a specific range in a Google Sheet.',
  {
    spreadsheet_id: z.string().describe('The Google Sheets spreadsheet ID'),
    range: z.string().describe('A1 notation range (e.g., "Sheet1!A1:D10")'),
  },
  async (args) =>
    gmailHandler('read_sheet_range', (getAuth) =>
      readSheetRange({ spreadsheet_id: args.spreadsheet_id, range: args.range }, getAuth),
    ),
);

server.tool(
  'create_spreadsheet',
  'Create a new Google Spreadsheet.',
  {
    title: z.string().describe('Spreadsheet title'),
  },
  async (args) =>
    gmailHandler('create_spreadsheet', (getAuth) =>
      createSpreadsheet({ title: args.title }, getAuth),
    ),
);

server.tool(
  'write_sheet_range',
  'Write data to a specific range in a Google Sheet. Values are always written as RAW (no formula interpretation).',
  {
    spreadsheet_id: z.string().describe('The Google Sheets spreadsheet ID'),
    range: z.string().describe('A1 notation range (e.g., "Sheet1!A1")'),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('2D array of values to write'),
  },
  async (args) =>
    gmailHandler('write_sheet_range', (getAuth) =>
      writeSheetRange(
        { spreadsheet_id: args.spreadsheet_id, range: args.range, values: args.values },
        getAuth,
      ),
    ),
);

// ===== Slides Tools =====

server.tool(
  'get_presentation_metadata',
  'Get metadata for a Google Slides presentation (title, slide count, etc.).',
  {
    presentation_id: z.string().describe('The Google Slides presentation ID'),
  },
  async (args) =>
    gmailHandler('get_presentation_metadata', (getAuth) =>
      getPresentationMetadata({ presentation_id: args.presentation_id }, getAuth),
    ),
);

server.tool(
  'create_presentation',
  'Create a new Google Slides presentation.',
  {
    title: z.string().describe('Presentation title'),
  },
  async (args) =>
    gmailHandler('create_presentation', (getAuth) =>
      createPresentation({ title: args.title }, getAuth),
    ),
);

// ===== Documents Tool =====

server.tool(
  'read_document',
  'Read and extract text content from a local document file (PDF, DOCX, XLSX, PPTX, TXT, CSV, MD, HTML). The file must be in the attachments or drive-exports directory.',
  {
    path: z.string().describe('Local file path to read (must be under /workspace/group/attachments/ or /workspace/group/drive-exports/)'),
  },
  async (args) => {
    try {
      const result = await readDocument(args);
      const parts: string[] = [result.content];
      const meta: string[] = [];
      if (result.pageCount !== undefined) meta.push(`Pages: ${result.pageCount}`);
      if (result.sheetNames?.length) meta.push(`Sheets: ${result.sheetNames.join(', ')}`);
      if (result.truncated) meta.push('Output was truncated');
      const text = meta.length > 0 ? `[${meta.join(' | ')}]\n\n${parts.join('')}` : parts.join('');
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ---------- Start server ----------

const transport = new StdioServerTransport();
await server.connect(transport);
