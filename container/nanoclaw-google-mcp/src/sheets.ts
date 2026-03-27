// Sheets tool implementations

import { google } from 'googleapis';
import type { OAuth2Client } from 'googleapis-common';

type GetAuth = () => Promise<OAuth2Client | string>;

function authOrThrow(auth: OAuth2Client | string): OAuth2Client {
  if (typeof auth === 'string') throw new Error(auth);
  return auth;
}

const MAX_ROWS = 1000;
const MAX_COLS = 50;

export async function listSheets(
  args: { spreadsheet_id: string },
  getAuth: GetAuth,
) {
  const auth = authOrThrow(await getAuth());
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.get({
    spreadsheetId: args.spreadsheet_id,
    fields: 'sheets.properties',
  });

  return (res.data.sheets ?? []).map((s) => ({
    sheetId: s.properties?.sheetId,
    title: s.properties?.title,
    index: s.properties?.index,
    rowCount: s.properties?.gridProperties?.rowCount,
    columnCount: s.properties?.gridProperties?.columnCount,
  }));
}

export async function readSheetRange(
  args: { spreadsheet_id: string; range: string },
  getAuth: GetAuth,
) {
  const auth = authOrThrow(await getAuth());
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: args.spreadsheet_id,
    range: args.range,
  });

  let values = res.data.values ?? [];
  let truncated = false;

  if (values.length > MAX_ROWS) {
    values = values.slice(0, MAX_ROWS);
    truncated = true;
  }

  values = values.map((row) => {
    if (row.length > MAX_COLS) {
      truncated = true;
      return row.slice(0, MAX_COLS);
    }
    return row;
  });

  const result: { range: string; values: string[][]; truncated?: boolean } = {
    range: res.data.range ?? args.range,
    values: values as string[][],
  };

  if (truncated) {
    result.truncated = true;
  }

  return result;
}

export async function createSpreadsheet(
  args: { title: string },
  getAuth: GetAuth,
) {
  const auth = authOrThrow(await getAuth());
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: args.title,
      },
    },
  });

  return {
    spreadsheetId: res.data.spreadsheetId,
    title: res.data.properties?.title,
    spreadsheetUrl: res.data.spreadsheetUrl,
  };
}

/**
 * SECURITY: valueInputOption is hardcoded to 'RAW' to prevent formula injection.
 * This must NEVER be configurable by the caller.
 */
export async function writeSheetRange(
  args: { spreadsheet_id: string; range: string; values: unknown[][] },
  getAuth: GetAuth,
) {
  const auth = authOrThrow(await getAuth());
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.update({
    spreadsheetId: args.spreadsheet_id,
    range: args.range,
    valueInputOption: 'RAW',
    requestBody: {
      values: args.values,
    },
  });

  return {
    updatedRange: res.data.updatedRange,
    updatedRows: res.data.updatedRows,
    updatedColumns: res.data.updatedColumns,
    updatedCells: res.data.updatedCells,
  };
}
