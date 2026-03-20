import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock fs
const mockReadFileSync = vi.fn();
vi.mock('fs', () => ({
  default: {
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    cpSync: vi.fn(),
  },
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

import { readEnvFile } from './env.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readEnvFile', () => {
  it('reads key=value pairs from .env file', () => {
    mockReadFileSync.mockReturnValue('FOO=bar\nBAZ=qux');
    const result = readEnvFile(['FOO', 'BAZ']);
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('only returns requested keys', () => {
    mockReadFileSync.mockReturnValue('FOO=bar\nBAZ=qux\nSECRET=hidden');
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'bar' });
    expect(result).not.toHaveProperty('BAZ');
    expect(result).not.toHaveProperty('SECRET');
  });

  it('handles double-quoted values', () => {
    mockReadFileSync.mockReturnValue('FOO="hello world"');
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'hello world' });
  });

  it('handles single-quoted values', () => {
    mockReadFileSync.mockReturnValue("FOO='hello world'");
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'hello world' });
  });

  it('returns empty object when .env file is missing', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({});
  });

  it('ignores comments and blank lines', () => {
    mockReadFileSync.mockReturnValue('# comment\n\nFOO=bar\n  # another comment\n');
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('handles values with = signs', () => {
    mockReadFileSync.mockReturnValue('KEY=base64data==');
    const result = readEnvFile(['KEY']);
    expect(result).toEqual({ KEY: 'base64data==' });
  });

  it('omits keys with empty values', () => {
    mockReadFileSync.mockReturnValue('EMPTY=\nFOO=bar');
    const result = readEnvFile(['EMPTY', 'FOO']);
    expect(result).toEqual({ FOO: 'bar' });
    expect(result).not.toHaveProperty('EMPTY');
  });

  it('handles keys with spaces around =', () => {
    mockReadFileSync.mockReturnValue('FOO = bar');
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'bar' });
  });
});
