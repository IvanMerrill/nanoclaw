// Docs tool implementations

import { google } from 'googleapis';
import type { OAuth2Client } from 'googleapis-common';

type GetAuth = () => Promise<OAuth2Client | string>;

function authOrThrow(auth: OAuth2Client | string): OAuth2Client {
  if (typeof auth === 'string') throw new Error(auth);
  return auth;
}

export async function getDocMetadata(
  args: { document_id: string },
  getAuth: GetAuth,
) {
  const auth = authOrThrow(await getAuth());
  const docs = google.docs({ version: 'v1', auth });

  const res = await docs.documents.get({
    documentId: args.document_id,
    fields: 'documentId,title,revisionId',
  });

  return {
    documentId: res.data.documentId,
    title: res.data.title,
    revisionId: res.data.revisionId,
  };
}

export async function createDoc(
  args: { title: string; folder_id?: string },
  getAuth: GetAuth,
) {
  const auth = authOrThrow(await getAuth());
  const docs = google.docs({ version: 'v1', auth });

  const res = await docs.documents.create({
    requestBody: {
      title: args.title,
    },
  });

  const documentId = res.data.documentId!;
  const title = res.data.title!;

  if (args.folder_id) {
    // Newly created docs always land in 'root', so removeParents is hardcoded.
    // The same OAuth2Client (auth) works for both Docs and Drive API calls.
    const drive = google.drive({ version: 'v3', auth });
    try {
      await drive.files.update({
        fileId: documentId,
        addParents: args.folder_id,
        removeParents: 'root',
        fields: 'id,parents',
      });
    } catch (err) {
      // Partial failure: doc was created but move failed.
      // Throw with documentId in the message so the caller isn't left without it.
      // gmailHandler in index.ts will catch this throw and return it as isError: true.
      throw new Error(
        `Doc was created (documentId: ${documentId}) but could not be moved to folder ${args.folder_id}: ${err instanceof Error ? err.message : String(err)}. Move manually or use move_drive_file.`,
      );
    }
  }

  return { documentId, title };
}

export async function updateDoc(
  args: { document_id: string; text: string; insert_at_start?: boolean },
  getAuth: GetAuth,
) {
  const auth = authOrThrow(await getAuth());
  const docs = google.docs({ version: 'v1', auth });

  const insertAtStart = args.insert_at_start ?? false;

  const request: Record<string, unknown> = {
    insertText: {
      text: args.text,
      ...(insertAtStart
        ? { location: { index: 1 } }
        : { endOfSegmentLocation: {} }),
    },
  };

  await docs.documents.batchUpdate({
    documentId: args.document_id,
    requestBody: {
      requests: [request],
    },
  });

  return { success: true, documentId: args.document_id };
}
