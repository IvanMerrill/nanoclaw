import { describe, expect, it } from 'vitest';

import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('redacts GitHub classic PATs', () => {
    const pat = 'ghp_' + 'A'.repeat(36);
    expect(redactSecrets(`Token is ${pat}`)).toBe('Token is [REDACTED]');
  });

  it('redacts GitHub fine-grained PATs', () => {
    const pat = 'github_pat_' + 'A'.repeat(82);
    expect(redactSecrets(`My token: ${pat}`)).toBe('My token: [REDACTED]');
  });

  it('redacts Anthropic API keys', () => {
    const key = 'sk-ant-' + 'a1b2c3-'.repeat(12) + 'a'.repeat(8);
    expect(redactSecrets(`Key: ${key}`)).toBe('Key: [REDACTED]');
  });

  it('redacts OpenAI API keys', () => {
    const key = 'sk-' + 'A'.repeat(48);
    expect(redactSecrets(`OpenAI: ${key}`)).toBe('OpenAI: [REDACTED]');
  });

  it('redacts Slack bot tokens', () => {
    expect(redactSecrets('Token: xoxb-1234-5678-abcdef')).toBe(
      'Token: [REDACTED]',
    );
  });

  it('redacts Telegram bot tokens', () => {
    const token = 'Bot 123456789:' + 'A'.repeat(35);
    expect(redactSecrets(`Auth: ${token}`)).toBe('Auth: [REDACTED]');
  });

  it('redacts Telegram bot tokens in API URLs', () => {
    const token = 'bot123456789:' + 'A'.repeat(35);
    expect(
      redactSecrets(`URL: https://api.telegram.org/file/${token}/photo.jpg`),
    ).toBe('URL: https://api.telegram.org/file/[REDACTED]/photo.jpg');
  });

  it('passes through clean text unchanged', () => {
    const text = 'This is a normal message with no secrets.';
    expect(redactSecrets(text)).toBe(text);
  });

  it('redacts multiple secrets in one string', () => {
    const ghp = 'ghp_' + 'A'.repeat(36);
    const input = `${ghp} and xoxb-123-456-abc`;
    const result = redactSecrets(input);
    expect(result).toBe('[REDACTED] and [REDACTED]');
  });

  it('returns empty string unchanged', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('redacts Anthropic OAuth tokens with underscores', () => {
    // Real OAuth tokens contain underscores: sk-ant-oat01-..._...-_iGKjgAA
    const token = 'sk-ant-oat01-' + 'a1b2c3_d-'.repeat(9) + 'A'.repeat(8);
    const result = redactSecrets(`Token: ${token}`);
    expect(result).toBe('Token: [REDACTED]');
    // Verify no partial leak — nothing after [REDACTED]
    expect(result).not.toMatch(/\[REDACTED\].+/);
  });

  it('redacts Discord bot tokens', () => {
    const token = 'A'.repeat(24) + '.' + 'B'.repeat(6) + '.' + 'C'.repeat(27);
    expect(redactSecrets(`Discord: ${token}`)).toBe('Discord: [REDACTED]');
  });

  it('redacts AWS access key IDs', () => {
    const key = 'AKIA' + 'A'.repeat(16);
    expect(redactSecrets(`AWS: ${key}`)).toBe('AWS: [REDACTED]');
  });
});
