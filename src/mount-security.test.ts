import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config
vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/mock/config/mount-allowlist.json',
}));

// Mock fs
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRealpathSync = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
      readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
      realpathSync: (...args: unknown[]) => mockRealpathSync(...args),
    },
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    realpathSync: (...args: unknown[]) => mockRealpathSync(...args),
  };
});

// We need to re-import the module for each test to defeat the module-level cache.
// Use vi.resetModules() + dynamic import.

async function freshImport() {
  vi.resetModules();
  // Re-apply mocks after reset
  vi.doMock('./logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));
  vi.doMock('./config.js', () => ({
    MOUNT_ALLOWLIST_PATH: '/mock/config/mount-allowlist.json',
  }));
  vi.doMock('fs', () => ({
    default: {
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
      readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
      realpathSync: (...args: unknown[]) => mockRealpathSync(...args),
    },
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    realpathSync: (...args: unknown[]) => mockRealpathSync(...args),
  }));
  return import('./mount-security.js');
}

const VALID_ALLOWLIST = JSON.stringify({
  allowedRoots: [
    { path: '/home/user/projects', allowReadWrite: true, description: 'Projects' },
    { path: '/home/user/docs', allowReadWrite: false, description: 'Docs' },
  ],
  blockedPatterns: ['custom-secret'],
  nonMainReadOnly: true,
});

beforeEach(() => {
  vi.clearAllMocks();
});

// --- loadMountAllowlist ---

describe('loadMountAllowlist', () => {
  it('returns null when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const mod = await freshImport();

    expect(mod.loadMountAllowlist()).toBeNull();
  });

  it('returns parsed allowlist when valid', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(VALID_ALLOWLIST);
    const mod = await freshImport();

    const result = mod.loadMountAllowlist();
    expect(result).not.toBeNull();
    expect(result!.allowedRoots).toHaveLength(2);
    expect(result!.nonMainReadOnly).toBe(true);
  });

  it('merges default blocked patterns with user patterns', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(VALID_ALLOWLIST);
    const mod = await freshImport();

    const result = mod.loadMountAllowlist();
    expect(result!.blockedPatterns).toContain('.ssh');
    expect(result!.blockedPatterns).toContain('.gnupg');
    expect(result!.blockedPatterns).toContain('custom-secret');
  });

  it('returns null on invalid JSON', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not json{{{');
    const mod = await freshImport();

    expect(mod.loadMountAllowlist()).toBeNull();
  });

  it('returns null when allowedRoots not an array', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: 'not-an-array',
        blockedPatterns: [],
        nonMainReadOnly: true,
      }),
    );
    const mod = await freshImport();

    expect(mod.loadMountAllowlist()).toBeNull();
  });

  it('returns null when nonMainReadOnly not a boolean', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        allowedRoots: [],
        blockedPatterns: [],
        nonMainReadOnly: 'yes',
      }),
    );
    const mod = await freshImport();

    expect(mod.loadMountAllowlist()).toBeNull();
  });

  it('caches on second call', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(VALID_ALLOWLIST);
    const mod = await freshImport();

    const first = mod.loadMountAllowlist();
    const second = mod.loadMountAllowlist();
    expect(first).toBe(second); // same reference
    // readFileSync called only once
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });
});

// --- validateMount ---

describe('validateMount', () => {
  it('blocks all when no allowlist', async () => {
    mockExistsSync.mockReturnValue(false);
    const mod = await freshImport();

    const result = mod.validateMount(
      { hostPath: '/home/user/projects/repo' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist');
  });

  it('blocks .. in containerPath', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(VALID_ALLOWLIST);
    const mod = await freshImport();

    const result = mod.validateMount(
      { hostPath: '/home/user/projects/repo', containerPath: '../escape' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('..');
  });

  it('blocks absolute containerPath', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(VALID_ALLOWLIST);
    const mod = await freshImport();

    const result = mod.validateMount(
      { hostPath: '/home/user/projects/repo', containerPath: '/etc/passwd' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('must be relative');
  });

  it('blocks non-existent host path', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/mock/config/mount-allowlist.json') return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(VALID_ALLOWLIST);
    mockRealpathSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const mod = await freshImport();

    const result = mod.validateMount(
      { hostPath: '/nonexistent/path' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('blocks path matching blocked pattern (.ssh)', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(VALID_ALLOWLIST);
    mockRealpathSync.mockImplementation((p: string) => p);
    const mod = await freshImport();

    const result = mod.validateMount(
      { hostPath: '/home/user/projects/.ssh/keys' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.ssh');
  });

  it('blocks path not under any allowed root', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(VALID_ALLOWLIST);
    mockRealpathSync.mockImplementation((p: string) => p);
    const mod = await freshImport();

    const result = mod.validateMount(
      { hostPath: '/var/lib/data' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('allows path under allowed root', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(VALID_ALLOWLIST);
    mockRealpathSync.mockImplementation((p: string) => p);
    const mod = await freshImport();

    const result = mod.validateMount(
      { hostPath: '/home/user/projects/my-repo' },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe('/home/user/projects/my-repo');
  });

  it('forces read-only for non-main when configured', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(VALID_ALLOWLIST);
    mockRealpathSync.mockImplementation((p: string) => p);
    const mod = await freshImport();

    const result = mod.validateMount(
      { hostPath: '/home/user/projects/repo', readonly: false },
      false, // non-main
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });
});

// --- validateAdditionalMounts ---

describe('validateAdditionalMounts', () => {
  it('filters rejected, returns only valid', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(VALID_ALLOWLIST);
    mockRealpathSync.mockImplementation((p: string) => p);
    const mod = await freshImport();

    const mounts = [
      { hostPath: '/home/user/projects/repo1' }, // valid
      { hostPath: '/var/secret/data' }, // not under allowed root
      { hostPath: '/home/user/projects/repo2' }, // valid
    ];

    const result = mod.validateAdditionalMounts(mounts, 'test-group', true);
    expect(result).toHaveLength(2);
    expect(result[0].hostPath).toBe('/home/user/projects/repo1');
    expect(result[1].hostPath).toBe('/home/user/projects/repo2');
  });

  it('prefixes container path with /workspace/extra/', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(VALID_ALLOWLIST);
    mockRealpathSync.mockImplementation((p: string) => p);
    const mod = await freshImport();

    const result = mod.validateAdditionalMounts(
      [{ hostPath: '/home/user/projects/my-repo' }],
      'test-group',
      true,
    );
    expect(result).toHaveLength(1);
    expect(result[0].containerPath).toBe('/workspace/extra/my-repo');
  });
});

// --- generateAllowlistTemplate ---

describe('generateAllowlistTemplate', () => {
  it('returns valid JSON with expected structure', async () => {
    const mod = await freshImport();
    const template = mod.generateAllowlistTemplate();
    const parsed = JSON.parse(template);

    expect(parsed).toHaveProperty('allowedRoots');
    expect(parsed).toHaveProperty('blockedPatterns');
    expect(parsed).toHaveProperty('nonMainReadOnly');
    expect(Array.isArray(parsed.allowedRoots)).toBe(true);
    expect(Array.isArray(parsed.blockedPatterns)).toBe(true);
    expect(typeof parsed.nonMainReadOnly).toBe('boolean');
  });
});
