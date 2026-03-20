/**
 * Acknowledgment messages via a cheap/fast model (Haiku).
 * Sends a brief "thinking..." style message if the main agent
 * hasn't responded within a timeout, so the user knows it's working.
 */
import { request as httpsRequest } from 'https';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const ACK_DELAY_MS = 10_000;
const ACK_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Start an ack timer. Returns a cancel function.
 * If the main agent responds within ACK_DELAY_MS, call cancel() to suppress the ack.
 * Otherwise, Haiku generates a brief acknowledgment and sendFn delivers it.
 */
export function scheduleAck(
  messagePreview: string,
  sendFn: (text: string) => Promise<void>,
): () => void {
  let cancelled = false;

  const cancel = () => {
    cancelled = true;
  };

  setTimeout(async () => {
    if (cancelled) return;

    try {
      const text = await generateAck(messagePreview);
      if (!cancelled && text) {
        await sendFn(text);
      }
    } catch (err) {
      logger.debug({ err }, 'Ack generation failed (non-fatal)');
    }
  }, ACK_DELAY_MS);

  return cancel;
}

async function generateAck(messagePreview: string): Promise<string | null> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);

  const apiKey = secrets.ANTHROPIC_API_KEY;
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  if (!apiKey && !oauthToken) {
    return null;
  }

  // If OAuth, we need to exchange for a temp API key first.
  // For simplicity, use the credential proxy which is already running locally.
  // But the proxy is for containers. Instead, let's call the API directly.
  // OAuth tokens work as Bearer tokens on the API.

  const body = JSON.stringify({
    model: ACK_MODEL,
    max_tokens: 60,
    messages: [
      {
        role: 'user',
        content: `You are a friendly assistant named Ren. The user just sent you a message and you're about to start working on it, but it will take a moment. Generate a very brief (1 sentence, under 15 words) acknowledgment so they know you're on it. Be casual and natural — no emojis unless it really fits. Reference what they asked about if you can.

Their message: "${messagePreview.slice(0, 300)}"`,
      },
    ],
  });

  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'content-length': Buffer.byteLength(body).toString(),
    };

    if (apiKey) {
      headers['x-api-key'] = apiKey;
    } else if (oauthToken) {
      headers['authorization'] = `Bearer ${oauthToken}`;
    }

    const req = httpsRequest(
      {
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            const text = json.content?.[0]?.text?.trim();
            resolve(text || null);
          } catch {
            resolve(null);
          }
        });
      },
    );

    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}
