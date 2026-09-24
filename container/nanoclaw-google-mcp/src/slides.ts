// Slides tool implementations

import { google } from 'googleapis';
import type { OAuth2Client } from 'googleapis-common';

type GetAuth = () => Promise<OAuth2Client | string>;

function authOrThrow(auth: OAuth2Client | string): OAuth2Client {
  if (typeof auth === 'string') throw new Error(auth);
  return auth;
}

export async function getPresentationMetadata(
  args: { presentation_id: string },
  getAuth: GetAuth,
) {
  const auth = authOrThrow(await getAuth());
  const slides = google.slides({ version: 'v1', auth });

  const res = await slides.presentations.get({
    presentationId: args.presentation_id,
    fields: 'presentationId,title,slides.objectId',
  });

  return {
    presentationId: res.data.presentationId,
    title: res.data.title,
    slideCount: res.data.slides?.length ?? 0,
  };
}

export async function createPresentation(
  args: { title: string },
  getAuth: GetAuth,
) {
  const auth = authOrThrow(await getAuth());
  const slides = google.slides({ version: 'v1', auth });

  const res = await slides.presentations.create({
    requestBody: {
      title: args.title,
    },
  });

  return {
    presentationId: res.data.presentationId,
    title: res.data.title,
  };
}
