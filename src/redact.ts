/**
 * Credential redaction for outbound messages.
 * Scrubs known secret patterns before they reach chat channels.
 */

const SECRET_PATTERNS: RegExp[] = [
  // GitHub classic PATs
  /ghp_[A-Za-z0-9]{36}/g,
  // GitHub fine-grained PATs
  /github_pat_[A-Za-z0-9_]{82}/g,
  // Anthropic API keys
  /sk-ant-[A-Za-z0-9-]{80,}/g,
  // OpenAI API keys
  /sk-[A-Za-z0-9]{48}/g,
  // Slack bot tokens
  /xoxb-[0-9A-Za-z-]+/g,
  // Telegram bot tokens (e.g., "Bot 123456:ABCdef...")
  /Bot [0-9]+:[A-Za-z0-9_-]{35}/g,
];

/**
 * Replace known secret patterns in text with [REDACTED].
 * Returns the original text unchanged if no secrets are found.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex since we reuse global regexps
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}
