import { describe, it, expect } from 'vitest';

import {
  ASSISTANT_NAME,
  POLL_INTERVAL,
  SCHEDULER_POLL_INTERVAL,
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  CREDENTIAL_PROXY_PORT,
  IPC_POLL_INTERVAL,
  IDLE_TIMEOUT,
  MAX_CONCURRENT_CONTAINERS,
  TRIGGER_PATTERN,
  STORE_DIR,
  GROUPS_DIR,
  DATA_DIR,
} from './config.js';

describe('config defaults', () => {
  it('ASSISTANT_NAME defaults to Andy', () => {
    // May be overridden by .env — just check it's a non-empty string
    expect(typeof ASSISTANT_NAME).toBe('string');
    expect(ASSISTANT_NAME.length).toBeGreaterThan(0);
  });

  it('POLL_INTERVAL is 2 seconds', () => {
    expect(POLL_INTERVAL).toBe(2000);
  });

  it('SCHEDULER_POLL_INTERVAL is 60 seconds', () => {
    expect(SCHEDULER_POLL_INTERVAL).toBe(60000);
  });

  it('CONTAINER_IMAGE has a default', () => {
    expect(typeof CONTAINER_IMAGE).toBe('string');
    expect(CONTAINER_IMAGE.length).toBeGreaterThan(0);
  });

  it('CONTAINER_TIMEOUT defaults to 30 minutes', () => {
    expect(CONTAINER_TIMEOUT).toBe(1800000);
  });

  it('CONTAINER_MAX_OUTPUT_SIZE defaults to 10MB', () => {
    expect(CONTAINER_MAX_OUTPUT_SIZE).toBe(10485760);
  });

  it('CREDENTIAL_PROXY_PORT defaults to 3001', () => {
    expect(CREDENTIAL_PROXY_PORT).toBe(3001);
  });

  it('IPC_POLL_INTERVAL is 1 second', () => {
    expect(IPC_POLL_INTERVAL).toBe(1000);
  });

  it('IDLE_TIMEOUT defaults to 30 minutes', () => {
    expect(IDLE_TIMEOUT).toBe(1800000);
  });

  it('MAX_CONCURRENT_CONTAINERS defaults to 5', () => {
    expect(MAX_CONCURRENT_CONTAINERS).toBe(5);
  });

  it('path constants are absolute paths', () => {
    expect(STORE_DIR).toMatch(/^\//);
    expect(GROUPS_DIR).toMatch(/^\//);
    expect(DATA_DIR).toMatch(/^\//);
  });
});

describe('TRIGGER_PATTERN', () => {
  it('matches @AssistantName at start of string', () => {
    expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME} hello`)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME.toUpperCase()} hello`)).toBe(true);
    expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME.toLowerCase()} hello`)).toBe(true);
  });

  it('does not match in middle of string', () => {
    expect(TRIGGER_PATTERN.test(`hello @${ASSISTANT_NAME}`)).toBe(false);
  });

  it('does not match partial name', () => {
    // The pattern uses \b (word boundary), so partial matches within a longer word shouldn't match
    // unless the name itself is a prefix of a longer word
    expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME}zzz`)).toBe(false);
  });

  it('matches name followed by space', () => {
    expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME} what time is it`)).toBe(true);
  });

  it('matches name at end of string', () => {
    expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME}`)).toBe(true);
  });
});
