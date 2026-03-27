import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import { homedir } from 'os';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// Mock fs
const mockFiles: Record<string, string> = {};
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn((path: string) => path in mockFiles),
    readFileSync: vi.fn((path: string) => {
      if (path in mockFiles) return mockFiles[path];
      throw new Error(`ENOENT: no such file: ${path}`);
    }),
    writeFileSync: vi.fn((path: string, data: string) => {
      mockFiles[path] = data;
    }),
    mkdirSync: vi.fn(),
  };
});

// Mock googleapis
const mockRefreshAccessToken = vi.fn();

function MockOAuth2() {
  return {
    setCredentials: vi.fn(),
    refreshAccessToken: mockRefreshAccessToken,
  };
}

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: MockOAuth2,
    },
  },
}));

import {
  startGoogleTokenVendor,
  clearTokenCache,
} from './google-token-vendor.js';

function makeRequest(
  port: number,
  body: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/token',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('google-token-vendor', () => {
  const configDir = `${homedir()}/.nanoclaw-google-mcp`;
  let portCounter = 39100;

  beforeEach(() => {
    for (const key of Object.keys(mockFiles)) delete mockFiles[key];
    mockRefreshAccessToken.mockReset();
    clearTokenCache();
  });

  afterEach(() => {
    delete process.env.GOOGLE_TOKEN_VENDOR_PORT;
  });

  function nextPort(): number {
    return portCounter++;
  }

  it('returns valid token when credentials exist', async () => {
    mockFiles[`${configDir}/oauth-readonly.json`] = JSON.stringify({
      installed: {
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
      },
    });

    mockFiles[`${configDir}/readonly-credentials.json`] = JSON.stringify({
      access_token: 'valid-access-token',
      refresh_token: 'test-refresh-token',
      expiry_date: Date.now() + 3600_000,
    });

    const port = nextPort();
    process.env.GOOGLE_TOKEN_VENDOR_PORT = String(port);
    await startGoogleTokenVendor();

    const res = await makeRequest(
      port,
      JSON.stringify({ scope: 'readonly' }),
    );

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.access_token).toBe('valid-access-token');
    expect(data.expires_at).toBeDefined();
    // Must NOT expose secrets
    expect(data.refresh_token).toBeUndefined();
    expect(data.client_secret).toBeUndefined();
    expect(data.client_id).toBeUndefined();
  });

  it('returns 503 when credentials are missing', async () => {
    const port = nextPort();
    process.env.GOOGLE_TOKEN_VENDOR_PORT = String(port);
    await startGoogleTokenVendor();

    const res = await makeRequest(
      port,
      JSON.stringify({ scope: 'readonly' }),
    );

    expect(res.statusCode).toBe(503);
    const data = JSON.parse(res.body);
    expect(data.error).toContain('Missing');
  });

  it('refreshes token when near expiry', async () => {
    mockFiles[`${configDir}/oauth-readwrite.json`] = JSON.stringify({
      installed: {
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
      },
    });

    mockFiles[`${configDir}/readwrite-credentials.json`] = JSON.stringify({
      access_token: 'old-access-token',
      refresh_token: 'test-refresh-token',
      expiry_date: Date.now() + 30_000, // within 60s buffer
    });

    mockRefreshAccessToken.mockResolvedValue({
      credentials: {
        access_token: 'refreshed-access-token',
        refresh_token: 'test-refresh-token',
        expiry_date: Date.now() + 3600_000,
      },
    });

    const port = nextPort();
    process.env.GOOGLE_TOKEN_VENDOR_PORT = String(port);
    await startGoogleTokenVendor();

    const res = await makeRequest(
      port,
      JSON.stringify({ scope: 'readwrite' }),
    );

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.access_token).toBe('refreshed-access-token');
    expect(data.expires_at).toBeDefined();
    expect(mockRefreshAccessToken).toHaveBeenCalled();
    // Must NOT expose secrets
    expect(data.refresh_token).toBeUndefined();
    expect(data.client_secret).toBeUndefined();
  });
});
