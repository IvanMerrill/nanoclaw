/**
 * Standalone CLI for initial Google OAuth2 setup.
 *
 * Usage:
 *   node dist/auth.js readonly
 *   node dist/auth.js readwrite
 *
 * Reads OAuth client credentials, opens browser for consent,
 * captures the callback, and writes tokens to disk.
 */
import { google } from 'googleapis';
import { createServer } from 'http';
import { exec } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.nanoclaw-google-mcp');
const REDIRECT_URI = 'http://localhost:3000/callback';

const SCOPES: Record<string, string[]> = {
  readonly: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
  ],
  readwrite: [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/presentations',
  ],
};

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${cmd} "${url}"`, (err) => {
    if (err) {
      console.error(`Failed to open browser. Please visit:\n${url}`);
    }
  });
}

async function main(): Promise<void> {
  const scope = process.argv[2];
  if (scope !== 'readonly' && scope !== 'readwrite') {
    console.error('Usage: node dist/auth.js <readonly|readwrite>');
    process.exit(1);
  }

  // Ensure config directory exists
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  // Read OAuth client credentials
  const clientFile = join(CONFIG_DIR, `oauth-${scope}.json`);
  if (!existsSync(clientFile)) {
    console.error(`Missing OAuth client file: ${clientFile}`);
    console.error(
      `Download it from Google Cloud Console and save it as ${clientFile}`,
    );
    process.exit(1);
  }

  let clientConfig: {
    installed?: { client_id: string; client_secret: string };
    web?: { client_id: string; client_secret: string };
  };
  try {
    clientConfig = JSON.parse(readFileSync(clientFile, 'utf-8'));
  } catch {
    console.error(`Failed to parse ${clientFile} as JSON`);
    process.exit(1);
  }

  const creds = clientConfig.installed || clientConfig.web;
  if (!creds?.client_id || !creds?.client_secret) {
    console.error(
      `Invalid OAuth client file: missing client_id or client_secret`,
    );
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    REDIRECT_URI,
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES[scope],
    prompt: 'consent',
  });

  // Start temp HTTP server to capture callback
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith('/callback')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const url = new URL(req.url, 'http://localhost:3000');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'content-type': 'text/html' });
      res.end(`<h1>Authorization denied</h1><p>${error}</p>`);
      console.error(`Authorization error: ${error}`);
      server.close();
      process.exit(1);
      return;
    }

    if (!code) {
      res.writeHead(400, { 'content-type': 'text/html' });
      res.end('<h1>Missing authorization code</h1>');
      return;
    }

    try {
      const { tokens } = await oauth2Client.getToken(code);
      const credentialsFile = join(CONFIG_DIR, `${scope}-credentials.json`);
      writeFileSync(credentialsFile, JSON.stringify(tokens, null, 2));

      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<h1>Authorization successful!</h1><p>You can close this window.</p>',
      );
      console.log(`Tokens saved to ${credentialsFile}`);
      console.log('Authorization complete. You can close this terminal.');
      server.close();
      process.exit(0);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end('<h1>Failed to exchange authorization code</h1>');
      console.error('Token exchange failed:', err);
      server.close();
      process.exit(1);
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        'Port 3000 is already in use. Stop any service on that port and try again.',
      );
    } else {
      console.error('Server error:', err.message);
    }
    process.exit(1);
  });

  server.listen(3000, () => {
    console.log(`\nStarting OAuth flow for "${scope}" scope...\n`);
    console.log(`Opening browser to:\n${authUrl}\n`);
    console.log('Waiting for callback on http://localhost:3000/callback ...\n');
    openBrowser(authUrl);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
