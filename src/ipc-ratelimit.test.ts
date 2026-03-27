import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
const mockStatSync = vi.fn();
const mockUnlinkSync = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      statSync: (...args: unknown[]) => mockStatSync(...args),
      unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
    },
    statSync: (...args: unknown[]) => mockStatSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  };
});

import { _isOversizedIpcFile, _isRateLimited, _resetRateLimits } from './ipc.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
});

// --- isOversizedIpcFile ---

describe('isOversizedIpcFile', () => {
  it('returns false for file under 1MB', () => {
    mockStatSync.mockReturnValueOnce({ size: 500_000 });

    expect(_isOversizedIpcFile('/tmp/test.json', 'main')).toBe(false);
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('returns true and deletes file over 1MB', () => {
    mockStatSync.mockReturnValueOnce({ size: 2_000_000 });

    expect(_isOversizedIpcFile('/tmp/big.json', 'main')).toBe(true);
    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/big.json');
  });

  it('returns false at exactly 1,000,000 bytes', () => {
    mockStatSync.mockReturnValueOnce({ size: 1_000_000 });

    expect(_isOversizedIpcFile('/tmp/exact.json', 'main')).toBe(false);
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('returns true at 1,000,001 bytes', () => {
    mockStatSync.mockReturnValueOnce({ size: 1_000_001 });

    expect(_isOversizedIpcFile('/tmp/over.json', 'main')).toBe(true);
    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/over.json');
  });

  it('returns true when stat throws', () => {
    mockStatSync.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });

    expect(_isOversizedIpcFile('/tmp/gone.json', 'main')).toBe(true);
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('logs warning with file path, size, and group name', () => {
    mockStatSync.mockReturnValueOnce({ size: 5_000_000 });

    _isOversizedIpcFile('/tmp/huge.json', 'test-group');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/huge.json',
        size: 5_000_000,
        sourceGroup: 'test-group',
      }),
      expect.stringContaining('Oversized IPC file'),
    );
  });
});

// --- isRateLimited ---

describe('isRateLimited', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false for first message', () => {
    expect(_isRateLimited('group-a')).toBe(false);
  });

  it('returns false at 20th message (exactly at limit)', () => {
    for (let i = 0; i < 19; i++) {
      _isRateLimited('group-b');
    }
    // 20th message
    expect(_isRateLimited('group-b')).toBe(false);
  });

  it('returns true at 21st message', () => {
    for (let i = 0; i < 20; i++) {
      _isRateLimited('group-c');
    }
    // 21st message
    expect(_isRateLimited('group-c')).toBe(true);
  });

  it('resets counter after 60s window', () => {
    for (let i = 0; i < 20; i++) {
      _isRateLimited('group-d');
    }
    expect(_isRateLimited('group-d')).toBe(true);

    // Advance 61 seconds
    vi.advanceTimersByTime(61_000);

    // Should reset — first message in new window
    expect(_isRateLimited('group-d')).toBe(false);
  });

  it('tracks separate counters per group', () => {
    for (let i = 0; i < 20; i++) {
      _isRateLimited('group-e');
    }
    // group-e is at limit
    expect(_isRateLimited('group-e')).toBe(true);
    // group-f is fresh
    expect(_isRateLimited('group-f')).toBe(false);
  });

  it('logs warning when limit exceeded', () => {
    for (let i = 0; i < 20; i++) {
      _isRateLimited('group-g');
    }
    _isRateLimited('group-g');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceGroup: 'group-g',
        limit: 20,
      }),
      expect.stringContaining('rate limit exceeded'),
    );
  });
});
