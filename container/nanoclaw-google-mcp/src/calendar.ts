// Calendar tool implementations

import { google } from 'googleapis';
import type { OAuth2Client } from 'googleapis-common';

type GetAuth = () => Promise<OAuth2Client | string>;

function authOrThrow(auth: OAuth2Client | string): OAuth2Client {
  if (typeof auth === 'string') throw new Error(auth);
  return auth;
}

export async function listEvents(
  args: {
    time_min?: string;
    time_max?: string;
    max_results?: number;
    query?: string;
    order_by?: 'startTime' | 'updated';
  },
  getAuth: GetAuth,
) {
  const auth = authOrThrow(await getAuth());
  const calendar = google.calendar({ version: 'v3', auth });

  const maxResults = Math.min(args.max_results ?? 20, 100);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: args.time_min,
    timeMax: args.time_max,
    maxResults,
    orderBy: args.order_by ?? 'startTime',
    singleEvents: true,
    q: args.query,
  });

  const events = (res.data.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start,
    end: e.end,
    location: e.location,
    description: e.description,
    status: e.status,
  }));

  return events;
}

export async function getEvent(
  args: { event_id: string },
  getAuth: GetAuth,
) {
  const auth = authOrThrow(await getAuth());
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.get({
    calendarId: 'primary',
    eventId: args.event_id,
  });

  const e = res.data;
  return {
    id: e.id,
    summary: e.summary,
    start: e.start,
    end: e.end,
    location: e.location,
    description: e.description,
    status: e.status,
    attendees: e.attendees,
  };
}

export async function createEvent(
  args: {
    summary: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    attendees?: string[];
    timezone?: string;
  },
  getAuth: GetAuth,
) {
  const auth = authOrThrow(await getAuth());
  const calendar = google.calendar({ version: 'v3', auth });

  const startObj: { dateTime: string; timeZone?: string } = { dateTime: args.start };
  const endObj: { dateTime: string; timeZone?: string } = { dateTime: args.end };
  if (args.timezone) {
    startObj.timeZone = args.timezone;
    endObj.timeZone = args.timezone;
  }

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: args.summary,
      start: startObj,
      end: endObj,
      description: args.description,
      location: args.location,
      attendees: args.attendees?.map((email) => ({ email })),
    },
  });

  const e = res.data;
  return {
    id: e.id,
    summary: e.summary,
    start: e.start,
    end: e.end,
    htmlLink: e.htmlLink,
  };
}

export async function updateEvent(
  args: {
    event_id: string;
    summary?: string;
    start?: string;
    end?: string;
    description?: string;
    location?: string;
    attendees?: string[];
  },
  getAuth: GetAuth,
) {
  const auth = authOrThrow(await getAuth());
  const calendar = google.calendar({ version: 'v3', auth });

  const requestBody: Record<string, unknown> = {};
  if (args.summary !== undefined) requestBody.summary = args.summary;
  if (args.start !== undefined) requestBody.start = { dateTime: args.start };
  if (args.end !== undefined) requestBody.end = { dateTime: args.end };
  if (args.description !== undefined) requestBody.description = args.description;
  if (args.location !== undefined) requestBody.location = args.location;
  if (args.attendees !== undefined) requestBody.attendees = args.attendees.map((email) => ({ email }));

  const res = await calendar.events.patch({
    calendarId: 'primary',
    eventId: args.event_id,
    requestBody,
  });

  const e = res.data;
  return {
    id: e.id,
    summary: e.summary,
    start: e.start,
    end: e.end,
    location: e.location,
    description: e.description,
    status: e.status,
    attendees: e.attendees,
    htmlLink: e.htmlLink,
  };
}

export async function deleteEvent(
  args: { event_id: string },
  getAuth: GetAuth,
) {
  const auth = authOrThrow(await getAuth());
  const calendar = google.calendar({ version: 'v3', auth });

  await calendar.events.delete({
    calendarId: 'primary',
    eventId: args.event_id,
  });

  return { success: true };
}
