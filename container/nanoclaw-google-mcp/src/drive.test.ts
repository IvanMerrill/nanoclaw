import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OAuth2Client } from 'googleapis-common';

// Mock googleapis before importing modules under test.
// vi.fn() calls outside the factory are hoisted by vitest and captured in the closure.
const mockFilesCreate = vi.fn();
const mockFilesGet = vi.fn();
const mockFilesUpdate = vi.fn();
const mockDocsCreate = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    drive: () => ({
      files: {
        create: mockFilesCreate,
        get: mockFilesGet,
        update: mockFilesUpdate,
      },
    }),
    docs: () => ({
      documents: {
        create: mockDocsCreate,
      },
    }),
  },
}));

import { createDriveFolder, moveDriveFile } from './drive.js';
import { createDoc } from './docs.js';

// Pattern A auth (drive tools): scope-aware
const fakeGetAuth = async (_scope: 'readonly' | 'readwrite') => ({} as OAuth2Client);
// Pattern B auth (docs tools): no scope param
const fakeGetAuthDocs = async () => ({} as OAuth2Client);
// Auth that returns a string (simulates failure)
const failingGetAuth = async (_scope: 'readonly' | 'readwrite') =>
  'Google authentication is not set up.';

// ===== createDriveFolder =====

describe('createDriveFolder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates folder at root when parent_folder_id is omitted', async () => {
    mockFilesCreate.mockResolvedValue({
      data: {
        id: 'folder-123',
        name: 'Recipes',
        webViewLink: 'https://drive.google.com/folders/folder-123',
      },
    });

    const result = await createDriveFolder({ name: 'Recipes' }, fakeGetAuth);

    expect(mockFilesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          name: 'Recipes',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['root'],
        }),
      }),
    );
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.id).toBe('folder-123');
    expect(body.name).toBe('Recipes');
    expect(body.webViewLink).toBeTruthy();
  });

  it('creates folder with the specified parent_folder_id', async () => {
    mockFilesCreate.mockResolvedValue({
      data: { id: 'child-folder', name: 'Italian', webViewLink: 'https://drive.google.com/folders/child' },
    });

    await createDriveFolder({ name: 'Italian', parent_folder_id: 'parent-abc' }, fakeGetAuth);

    expect(mockFilesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          parents: ['parent-abc'],
        }),
      }),
    );
  });

  it('returns error and does not call API for empty name', async () => {
    const result = await createDriveFolder({ name: '' }, fakeGetAuth);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Folder name must not be empty.');
    expect(mockFilesCreate).not.toHaveBeenCalled();
  });

  it('returns error and does not call API for whitespace-only name', async () => {
    const result = await createDriveFolder({ name: '   ' }, fakeGetAuth);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Folder name must not be empty.');
    expect(mockFilesCreate).not.toHaveBeenCalled();
  });

  it('returns error when the Drive API call fails', async () => {
    const apiError = Object.assign(new Error('Insufficient permissions'), { code: 403 });
    mockFilesCreate.mockRejectedValue(apiError);

    const result = await createDriveFolder({ name: 'Test' }, fakeGetAuth);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to create folder');
    expect(result.content[0].text).toContain('Insufficient permissions');
  });

  it('returns auth error string when auth fails (no API call made)', async () => {
    const result = await createDriveFolder({ name: 'Test' }, failingGetAuth);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Google authentication is not set up.');
    expect(mockFilesCreate).not.toHaveBeenCalled();
  });
});

// ===== moveDriveFile =====

describe('moveDriveFile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches current parents then reparents to destination', async () => {
    mockFilesGet.mockResolvedValue({
      data: { id: 'file-1', parents: ['folder-a'] },
    });
    mockFilesUpdate.mockResolvedValue({
      data: { id: 'file-1', name: 'doc.txt', parents: ['folder-b'] },
    });

    const result = await moveDriveFile(
      { file_id: 'file-1', destination_folder_id: 'folder-b' },
      fakeGetAuth,
    );

    expect(mockFilesGet).toHaveBeenCalledWith({ fileId: 'file-1', fields: 'id,parents' });
    expect(mockFilesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'file-1',
        addParents: 'folder-b',
        removeParents: 'folder-a',
      }),
    );
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.id).toBe('file-1');
    expect(body.parentId).toBe('folder-b');
  });

  it('joins multiple current parents as comma-separated string in removeParents', async () => {
    mockFilesGet.mockResolvedValue({
      data: { id: 'file-1', parents: ['folder-a', 'folder-x'] },
    });
    mockFilesUpdate.mockResolvedValue({
      data: { id: 'file-1', name: 'doc.txt', parents: ['folder-b'] },
    });

    await moveDriveFile({ file_id: 'file-1', destination_folder_id: 'folder-b' }, fakeGetAuth);

    expect(mockFilesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ removeParents: 'folder-a,folder-x' }),
    );
  });

  it('omits removeParents entirely (not empty string) when file has no current parents', async () => {
    mockFilesGet.mockResolvedValue({
      data: { id: 'file-1', parents: [] },
    });
    mockFilesUpdate.mockResolvedValue({
      data: { id: 'file-1', name: 'doc.txt', parents: ['folder-b'] },
    });

    await moveDriveFile({ file_id: 'file-1', destination_folder_id: 'folder-b' }, fakeGetAuth);

    const updateArg = mockFilesUpdate.mock.calls[0][0];
    expect(updateArg).not.toHaveProperty('removeParents');
  });

  it('returns file-not-found error when Step 1 (files.get) returns 404', async () => {
    mockFilesGet.mockRejectedValue(Object.assign(new Error('Not found'), { code: 404 }));

    const result = await moveDriveFile(
      { file_id: 'missing-file', destination_folder_id: 'folder-b' },
      fakeGetAuth,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('File missing-file not found in Drive.');
    expect(mockFilesUpdate).not.toHaveBeenCalled();
  });

  it('returns destination-not-found error when Step 2 (files.update) returns 404', async () => {
    mockFilesGet.mockResolvedValue({ data: { id: 'file-1', parents: ['folder-a'] } });
    mockFilesUpdate.mockRejectedValue(Object.assign(new Error('Not found'), { code: 404 }));

    const result = await moveDriveFile(
      { file_id: 'file-1', destination_folder_id: 'missing-folder' },
      fakeGetAuth,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Destination folder missing-folder not found in Drive.');
  });

  it('returns circular-move error when Step 2 returns 400', async () => {
    mockFilesGet.mockResolvedValue({ data: { id: 'folder-1', parents: ['parent'] } });
    mockFilesUpdate.mockRejectedValue(Object.assign(new Error('Bad request'), { code: 400 }));

    const result = await moveDriveFile(
      { file_id: 'folder-1', destination_folder_id: 'folder-1' },
      fakeGetAuth,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Cannot move a folder into its own subfolder.');
  });

  it('returns generic error for unexpected API errors in Step 2', async () => {
    mockFilesGet.mockResolvedValue({ data: { id: 'file-1', parents: ['folder-a'] } });
    mockFilesUpdate.mockRejectedValue(
      Object.assign(new Error('Internal server error'), { code: 500 }),
    );

    const result = await moveDriveFile(
      { file_id: 'file-1', destination_folder_id: 'folder-b' },
      fakeGetAuth,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to move file');
    expect(result.content[0].text).toContain('Internal server error');
  });

  it('returns auth error string when auth fails (no API calls made)', async () => {
    const result = await moveDriveFile(
      { file_id: 'file-1', destination_folder_id: 'folder-b' },
      failingGetAuth,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Google authentication is not set up.');
    expect(mockFilesGet).not.toHaveBeenCalled();
    expect(mockFilesUpdate).not.toHaveBeenCalled();
  });
});

// ===== createDoc with folder_id =====

describe('createDoc', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates doc without folder_id — original behaviour, no Drive call', async () => {
    mockDocsCreate.mockResolvedValue({
      data: { documentId: 'doc-123', title: 'My Doc' },
    });

    const result = await createDoc({ title: 'My Doc' }, fakeGetAuthDocs);

    expect(mockDocsCreate).toHaveBeenCalledWith({ requestBody: { title: 'My Doc' } });
    expect(mockFilesUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ documentId: 'doc-123', title: 'My Doc' });
  });

  it('creates doc and reparents when folder_id is provided', async () => {
    mockDocsCreate.mockResolvedValue({
      data: { documentId: 'doc-456', title: 'Recipe Doc' },
    });
    mockFilesUpdate.mockResolvedValue({
      data: { id: 'doc-456', parents: ['folder-recipes'] },
    });

    const result = await createDoc(
      { title: 'Recipe Doc', folder_id: 'folder-recipes' },
      fakeGetAuthDocs,
    );

    expect(mockDocsCreate).toHaveBeenCalledWith({ requestBody: { title: 'Recipe Doc' } });
    expect(mockFilesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'doc-456',
        addParents: 'folder-recipes',
        removeParents: 'root',
      }),
    );
    expect(result).toEqual({ documentId: 'doc-456', title: 'Recipe Doc' });
  });

  it('throws with documentId in message when doc created but move fails (partial failure)', async () => {
    mockDocsCreate.mockResolvedValue({
      data: { documentId: 'doc-789', title: 'Orphaned Doc' },
    });
    mockFilesUpdate.mockRejectedValue(new Error('Folder not found'));

    await expect(
      createDoc({ title: 'Orphaned Doc', folder_id: 'bad-folder' }, fakeGetAuthDocs),
    ).rejects.toThrow('doc-789');
  });

  it('throws when Docs creation itself fails (no Drive call attempted)', async () => {
    mockDocsCreate.mockRejectedValue(new Error('Docs API unavailable'));

    await expect(
      createDoc({ title: 'Bad Doc', folder_id: 'folder-abc' }, fakeGetAuthDocs),
    ).rejects.toThrow('Docs API unavailable');

    expect(mockFilesUpdate).not.toHaveBeenCalled();
  });
});
