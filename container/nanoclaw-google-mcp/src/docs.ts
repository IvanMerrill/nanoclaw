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
  args: { title: string },
  getAuth: GetAuth,
) {
  const auth = authOrThrow(await getAuth());
  const docs = google.docs({ version: 'v1', auth });

  const res = await docs.documents.create({
    requestBody: {
      title: args.title,
    },
  });

  return {
    documentId: res.data.documentId,
    title: res.data.title,
  };
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
