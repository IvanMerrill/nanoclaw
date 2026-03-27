/**
 * Google Token Vendor (host-side).
 *
 * Containers POST /token with { scope: "readonly" | "readwrite" } to get
 * a short-lived access token. The vendor reads OAuth client credentials
 * and cached refresh tokens from ~/.nanoclaw-google-mcp/, refreshes when
 * needed, and returns { access_token, expires_at }.
 *
 * NEVER exposes refresh_token, client_secret, or client_id in responses.
 */
import { createServer, Server } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { google } from 'googleapis';
import type { Credentials } from 'google-auth-library';
import { logger } from './logger.js';

const CONFIG_DIR = join(homedir(), '.nanoclaw-google-mcp');
const EXPIRY_BUFFER_MS = 60_000; // refresh if within 60s of expiry

type Scope = 'readonly' | 'readwrite';

interface CachedToken {
  access_token: string;
  expires_at: number; // epoch ms
}

const tokenCache = new Map<Scope, CachedToken>();

function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function getClientCredentials(
  scope: Scope,
): { client_id: string; client_secret: string } | null {
  const file = join(CONFIG_DIR, `oauth-${scope}.json`);
  if (!existsSync(file)) return null;
  const data = readJsonFile(file) as {
    installed?: { client_id: string; client_secret: string };
    web?: { client_id: string; client_secret: string };
  } | null;
  if (!data) return null;
  const creds = data.installed || data.web;
  if (!creds?.client_id || !creds?.client_secret) return null;
  return { client_id: creds.client_id, client_secret: creds.client_secret };
}

function getStoredTokens(scope: Scope): Credentials | null {
  const file = join(CONFIG_DIR, `${scope}-credentials.json`);
  if (!existsSync(file)) return null;
  const data = readJsonFile(file) as Credentials | null;
  return data;
}

function saveTokens(scope: Scope, tokens: Credentials): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const file = join(CONFIG_DIR, `${scope}-credentials.json`);
  writeFileSync(file, JSON.stringify(tokens, null, 2));
}

async function getAccessToken(
  scope: Scope,
): Promise<{ access_token: string; expires_at: number }> {
  // Check memory cache first
  const cached = tokenCache.get(scope);
  if (cached && cached.expires_at - Date.now() > EXPIRY_BUFFER_MS) {
    return cached;
  }

  const clientCreds = getClientCredentials(scope);
  if (!clientCreds) {
    throw new Error(`Missing OAuth client credentials for "${scope}" scope`);
  }

  const storedTokens = getStoredTokens(scope);
  if (!storedTokens) {
    throw new Error(
      `Missing cached tokens for "${scope}" scope. Run auth CLI first.`,
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    clientCreds.client_id,
    clientCreds.client_secret,
  );
  oauth2Client.setCredentials(storedTokens);

  // Check if current access token is still valid
  const expiryDate = storedTokens.expiry_date;
  if (
    storedTokens.access_token &&
    expiryDate &&
    expiryDate - Date.now() > EXPIRY_BUFFER_MS
  ) {
    const result = {
      access_token: storedTokens.access_token,
      expires_at: expiryDate,
    };
    tokenCache.set(scope, result);
    return result;
  }

  // Refresh the token
  const { credentials } = await oauth2Client.refreshAccessToken();
  if (!credentials.access_token) {
    throw new Error('Token refresh returned no access_token');
  }

  // Merge with existing tokens (preserve refresh_token if not returned)
  const merged: Credentials = {
    ...storedTokens,
    ...credentials,
    refresh_token: credentials.refresh_token || storedTokens.refresh_token,
  };
  saveTokens(scope, merged);

  const result = {
    access_token: credentials.access_token,
    expires_at: credentials.expiry_date || Date.now() + 3600_000,
  };
  tokenCache.set(scope, result);
  return result;
}

/** Clear the in-memory token cache (exported for testing). */
export function clearTokenCache(): void {
  tokenCache.clear();
}

export async function startGoogleTokenVendor(): Promise<number> {
  const port = parseInt(process.env.GOOGLE_TOKEN_VENDOR_PORT || '3002', 10);

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/token') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        let body: { scope?: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        const scope = body.scope;
        if (scope !== 'readonly' && scope !== 'readwrite') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'Invalid scope. Must be "readonly" or "readwrite"',
            }),
          );
          return;
        }

        try {
          const token = await getAccessToken(scope);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: token.access_token,
              expires_at: token.expires_at,
            }),
          );
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Unknown error';
          logger.warn({ scope, err: message }, 'Google token vendor error');
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: message }));
        }
      });
    });

    server.on('error', reject);

    server.listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'Google token vendor started');
      resolve(port);
    });
  });
}
