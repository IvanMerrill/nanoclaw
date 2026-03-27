import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readDocument, validatePath } from './documents.js';

// We use a temp directory that mimics the allowed path structure
// so we can test without requiring /workspace/group/ to exist.
let tmpDir: string;
let attachmentsDir: string;
let allowedPrefixes: string[];

beforeAll(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doc-test-')));
  attachmentsDir = path.join(tmpDir, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  allowedPrefixes = [attachmentsDir + '/'];
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(name: string, content: string | Buffer): string {
  const filePath = path.join(attachmentsDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('readDocument', () => {
  it('reads a .txt file from an allowed directory', async () => {
    const filePath = writeFixture('hello.txt', 'Hello, world!');
    const result = await readDocument({ path: filePath }, allowedPrefixes);
    expect(result.content).toBe('Hello, world!');
    expect(result.truncated).toBe(false);
  });

  it('returns error for unsupported file type (.exe)', async () => {
    const filePath = writeFixture('bad.exe', 'MZ...');
    await expect(readDocument({ path: filePath }, allowedPrefixes)).rejects.toThrow(
      'Unsupported file type: .exe',
    );
  });

  it('rejects path traversal (../../etc/passwd)', async () => {
    expect(() => validatePath('../../etc/passwd', allowedPrefixes)).toThrow(
      'Access denied: path outside permitted directories.',
    );
  });

  it('rejects absolute path outside sandbox (/etc/passwd)', async () => {
    expect(() => validatePath('/etc/passwd', allowedPrefixes)).toThrow(
      'Access denied: path outside permitted directories.',
    );
  });

  it('returns error for missing file (not crash)', async () => {
    const fakePath = path.join(attachmentsDir, 'nonexistent.txt');
    await expect(readDocument({ path: fakePath }, allowedPrefixes)).rejects.toThrow(
      /File not found/,
    );
  });

  it('truncates content exceeding 20,000 chars', async () => {
    const bigContent = 'A'.repeat(25_000);
    const filePath = writeFixture('big.txt', bigContent);
    const result = await readDocument({ path: filePath }, allowedPrefixes);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('[truncated at 20,000 chars]');
    // 20,000 chars of content + the truncation marker
    expect(result.content.length).toBeLessThan(25_100);
  });

  it('rejects file larger than 20MB', async () => {
    // Create a sparse-ish file > 20MB by writing a header and seeking
    const filePath = path.join(attachmentsDir, 'huge.txt');
    const fd = fs.openSync(filePath, 'w');
    // Write 1 byte at 21MB offset to make stat report 21MB+
    const offset = 21 * 1024 * 1024;
    const buf = Buffer.from('x');
    fs.writeSync(fd, buf, 0, 1, offset);
    fs.closeSync(fd);

    await expect(readDocument({ path: filePath }, allowedPrefixes)).rejects.toThrow(
      /File too large.*exceeds 20MB limit/,
    );

    fs.unlinkSync(filePath);
  });

  it('reads .html files and strips tags', async () => {
    const html = '<html><body><p>Hello &amp; <b>world</b></p></body></html>';
    const filePath = writeFixture('test.html', html);
    const result = await readDocument({ path: filePath }, allowedPrefixes);
    expect(result.content).toContain('Hello & world');
    expect(result.content).not.toContain('<p>');
    expect(result.truncated).toBe(false);
  });

  it('reads .csv files as plain text', async () => {
    const csv = 'name,age\nAlice,30\nBob,25';
    const filePath = writeFixture('data.csv', csv);
    const result = await readDocument({ path: filePath }, allowedPrefixes);
    expect(result.content).toBe(csv);
    expect(result.truncated).toBe(false);
  });

  it('rejects symlinks that point outside allowed directories', async () => {
    const linkPath = path.join(attachmentsDir, 'sneaky.txt');
    try {
      fs.symlinkSync('/etc/hosts', linkPath);
    } catch {
      // Skip on systems where symlink creation fails
      return;
    }
    expect(() => validatePath(linkPath, allowedPrefixes)).toThrow(
      'Access denied: path outside permitted directories.',
    );
    fs.unlinkSync(linkPath);
  });
});
