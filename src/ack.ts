/**
 * Acknowledgment messages via a cheap/fast model (Haiku).
 * Sends a brief "working on it" message if the main agent hasn't responded
 * within a delay, then repeats every REPEAT_INTERVAL_MS while still waiting.
 *
 * Routes through the local credential proxy so both API-key and OAuth
 * auth modes work without duplicating auth logic.
 */
import { request as httpRequest } from 'http';

import { CREDENTIAL_PROXY_PORT } from './config.js';
import { logger } from './logger.js';

export const INITIAL_DELAY_MS = 10_000;
export const REPEAT_INTERVAL_MS = 60_000;
const ACK_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Start an ack timer. Returns a cancel function.
 * Fires once after INITIAL_DELAY_MS, then every REPEAT_INTERVAL_MS until cancelled.
 */
export function scheduleAck(
  messagePreview: string,
  assistantName: string,
  sendFn: (text: string) => Promise<void>,
): () => void {
  let cancelled = false;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatTimer: ReturnType<typeof setInterval> | null = null;

  const cancel = () => {
    cancelled = true;
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (repeatTimer) {
      clearInterval(repeatTimer);
      repeatTimer = null;
    }
  };

  const sendAck = async (isFollowUp: boolean) => {
    if (cancelled) return;
    try {
      const text = await generateAck(messagePreview, assistantName, isFollowUp);
      if (!cancelled && text) {
        await sendFn(text);
      }
    } catch (err) {
      logger.debug({ err }, 'Ack generation failed (non-fatal)');
    }
  };

  // Initial ack after delay
  initialTimer = setTimeout(async () => {
    initialTimer = null;
    if (cancelled) return;
    await sendAck(false);

    // Then repeat every 60s
    if (!cancelled) {
      repeatTimer = setInterval(() => sendAck(true), REPEAT_INTERVAL_MS);
    }
  }, INITIAL_DELAY_MS);

  return cancel;
}

async function generateAck(
  messagePreview: string,
  assistantName: string,
  isFollowUp: boolean,
): Promise<string | null> {
  const prompt = isFollowUp
    ? `You are a friendly assistant named ${assistantName}. You're still working on the user's request and it's taking a while. Generate a very brief (1 sentence, under 15 words) status update so they know you're still on it. Be casual and natural — no emojis unless it really fits. Don't repeat yourself. Vary your phrasing.\n\nTheir original message: "${messagePreview.slice(0, 300)}"`
    : `You are a friendly assistant named ${assistantName}. The user just sent you a message and you're about to start working on it, but it will take a moment. Generate a very brief (1 sentence, under 15 words) acknowledgment so they know you're on it. Be casual and natural — no emojis unless it really fits. Reference what they asked about if you can.\n\nTheir message: "${messagePreview.slice(0, 300)}"`;

  const body = JSON.stringify({
    model: ACK_MODEL,
    max_tokens: 60,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: CREDENTIAL_PROXY_PORT,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': 'proxy-placeholder',
          'content-length': Buffer.byteLength(body),
        },
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
