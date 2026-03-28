// Drive tool implementations

import { google } from 'googleapis';
import type { OAuth2Client } from 'googleapis-common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Readable } from 'stream';

type GetAuth = (scope: 'readonly' | 'readwrite') => Promise<OAuth2Client | string>;

// ---------- Shared utility ----------

export function sanitizeFilename(name: string): string {
  if (name.includes('..')) throw new Error('Filename contains ".."');
  let sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '');
  sanitized = sanitized.replace(/\.{2,}/g, '.');
  if (!sanitized) sanitized = 'attachment_unnamed';
  return sanitized;
}

// ---------- Constants ----------

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const EXPORT_DIR = '/workspace/group/drive-exports';

const GOOGLE_EXPORT_MAP: Record<string, { mimeType: string; extension: string }> = {
  'application/vnd.google-apps.document': { mimeType: 'text/plain', extension: '.txt' },
  'application/vnd.google-apps.spreadsheet': { mimeType: 'text/csv', extension: '.csv' },
  'application/vnd.google-apps.presentation': { mimeType: 'text/plain', extension: '.txt' },
};

const BINARY_DOWNLOAD_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

// ---------- Helper ----------

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ---------- Tool implementations ----------

export async function listDriveFiles(args: {
  query?: string;
  max_results?: number;
  order_by?: string;
}, getAuth: GetAuth): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  const auth = await getAuth('readonly');
  if (typeof auth === 'string') return errorResult(auth);

  const drive = google.drive({ version: 'v3', auth });

  const maxResults = Math.min(Math.max(args.max_results ?? 20, 1), 100);

  try {
    const res = await drive.files.list({
      q: args.query || undefined,
      pageSize: maxResults,
      orderBy: args.order_by || undefined,
      fields: 'files(id,name,mimeType,modifiedTime,size,owners)',
    });

    const files = (res.data.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      size: f.size,
      owners: f.owners?.map((o) => o.displayName ?? o.emailAddress),
    }));

    return textResult(JSON.stringify(files, null, 2));
  } catch (err) {
    return errorResult(`Drive list error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function exportDriveFile(args: {
  file_id: string;
  filename?: string;
}, getAuth: GetAuth): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  const auth = await getAuth('readonly');
  if (typeof auth === 'string') return errorResult(auth);

  const drive = google.drive({ version: 'v3', auth });

  try {
    // Get file metadata first
    const meta = await drive.files.get({
      fileId: args.file_id,
      fields: 'id,name,mimeType,size',
    });

    const fileMimeType = meta.data.mimeType ?? '';
    const fileName = meta.data.name ?? 'unnamed';
    const fileSize = parseInt(meta.data.size ?? '0', 10);

    // Check size for non-Google-native files
    if (fileSize > MAX_FILE_SIZE) {
      return errorResult(`File too large: ${fileSize} bytes (max ${MAX_FILE_SIZE})`);
    }

    let data: Buffer;
    let exportFormat: string;
    let extension: string;

    const exportMapping = GOOGLE_EXPORT_MAP[fileMimeType];

    if (exportMapping) {
      // Google Workspace file — use export
      const res = await drive.files.export(
        { fileId: args.file_id, mimeType: exportMapping.mimeType },
        { responseType: 'arraybuffer' },
      );
      data = Buffer.from(res.data as ArrayBuffer);
      exportFormat = exportMapping.mimeType;
      extension = exportMapping.extension;
    } else if (BINARY_DOWNLOAD_TYPES.has(fileMimeType)) {
      // Binary file — direct download
      const res = await drive.files.get(
        { fileId: args.file_id, alt: 'media' },
        { responseType: 'stream' },
      );
      data = await streamToBuffer(res.data as unknown as Readable);
      exportFormat = fileMimeType;
      // Derive extension from mime type
      if (fileMimeType === 'application/pdf') extension = '.pdf';
      else if (fileMimeType.includes('wordprocessingml')) extension = '.docx';
      else if (fileMimeType.includes('spreadsheetml')) extension = '.xlsx';
      else extension = '';
    } else {
      return errorResult(
        `Unsupported file type for export: ${fileMimeType}. ` +
        `Supported: Google Docs/Sheets/Slides, PDF, DOCX, XLSX.`,
      );
    }

    // Check downloaded size
    if (data.length > MAX_FILE_SIZE) {
      return errorResult(`Exported content too large: ${data.length} bytes (max ${MAX_FILE_SIZE})`);
    }

    // Determine output filename
    let outputName: string;
    if (args.filename) {
      outputName = sanitizeFilename(args.filename);
    } else {
      const baseName = sanitizeFilename(fileName);
      outputName = baseName + extension;
    }

    // Ensure export directory exists
    await fs.mkdir(EXPORT_DIR, { recursive: true });

    const savedPath = path.join(EXPORT_DIR, outputName);
    await fs.writeFile(savedPath, data);

    return textResult(JSON.stringify({ savedPath, mimeType: fileMimeType, exportFormat }, null, 2));
  } catch (err) {
    return errorResult(`Drive export error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function uploadDriveFile(args: {
  name: string;
  content: string;
  mime_type?: string;
  folder_id?: string;
}, getAuth: GetAuth): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  const auth = await getAuth('readwrite');
  if (typeof auth === 'string') return errorResult(auth);

  const drive = google.drive({ version: 'v3', auth });

  const mimeType = args.mime_type ?? 'text/plain';

  try {
    const fileMetadata: { name: string; parents?: string[] } = {
      name: args.name,
    };
    if (args.folder_id) {
      fileMetadata.parents = [args.folder_id];
    }

    const res = await drive.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType,
        body: Readable.from(Buffer.from(args.content, 'utf-8')),
      },
      fields: 'id,name,webViewLink',
    });

    return textResult(
      JSON.stringify(
        {
          id: res.data.id,
          name: res.data.name,
          webViewLink: res.data.webViewLink,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    return errorResult(`Drive upload error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function updateDriveFileContent(args: {
  file_id: string;
  content: string;
  mime_type?: string;
}, getAuth: GetAuth): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  const auth = await getAuth('readwrite');
  if (typeof auth === 'string') return errorResult(auth);

  const drive = google.drive({ version: 'v3', auth });

  const mimeType = args.mime_type ?? 'text/plain';

  try {
    const res = await drive.files.update({
      fileId: args.file_id,
      media: {
        mimeType,
        body: Readable.from(Buffer.from(args.content, 'utf-8')),
      },
      fields: 'id,name,modifiedTime',
    });

    return textResult(
      JSON.stringify(
        {
          id: res.data.id,
          name: res.data.name,
          modifiedTime: res.data.modifiedTime,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    return errorResult(`Drive update error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function createDriveFolder(args: {
  name: string;
  parent_folder_id?: string;
}, getAuth: GetAuth): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  const trimmedName = (args.name ?? '').trim();
  if (!trimmedName) {
    return errorResult('Folder name must not be empty.');
  }

  const auth = await getAuth('readwrite');
  if (typeof auth === 'string') return errorResult(auth);

  const drive = google.drive({ version: 'v3', auth });

  try {
    const res = await drive.files.create({
      requestBody: {
        name: trimmedName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [args.parent_folder_id ?? 'root'],
      },
      fields: 'id,name,webViewLink',
    });

    return textResult(
      JSON.stringify(
        {
          id: res.data.id,
          name: res.data.name,
          webViewLink: res.data.webViewLink,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    return errorResult(`Failed to create folder: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function moveDriveFile(args: {
  file_id: string;
  destination_folder_id: string;
}, getAuth: GetAuth): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  const auth = await getAuth('readwrite');
  if (typeof auth === 'string') return errorResult(auth);

  const drive = google.drive({ version: 'v3', auth });

  // Step 1: fetch current parents so we can remove them
  let currentParents: string[];
  try {
    const fileRes = await drive.files.get({
      fileId: args.file_id,
      fields: 'id,parents',
    });
    currentParents = fileRes.data.parents ?? [];
  } catch (err) {
    if ((err as any).code === 404) {
      return errorResult(`File ${args.file_id} not found in Drive.`);
    }
    return errorResult(`Failed to move file: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 2: reparent — remove all current parents, set only the destination
  try {
    const updateRes = await drive.files.update({
      fileId: args.file_id,
      addParents: args.destination_folder_id,
      ...(currentParents.length > 0 ? { removeParents: currentParents.join(',') } : {}),
      fields: 'id,name,parents',
    });

    const confirmedParent =
      (updateRes.data.parents ?? [])[0] ?? args.destination_folder_id;

    return textResult(
      JSON.stringify(
        {
          id: updateRes.data.id,
          name: updateRes.data.name,
          parentId: confirmedParent,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    if ((err as any).code === 404) {
      return errorResult(`Destination folder ${args.destination_folder_id} not found in Drive.`);
    }
    if ((err as any).code === 400) {
      return errorResult('Cannot move a folder into its own subfolder.');
    }
    return errorResult(`Failed to move file: ${err instanceof Error ? err.message : String(err)}`);
  }
}
