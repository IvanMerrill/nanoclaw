import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock config
vi.mock('./config.js', () => ({
  CREDENTIAL_PROXY_PORT: 3001,
}));

// Mock http.request
const mockRequest = vi.fn();
vi.mock('http', () => ({
  request: (...args: unknown[]) => mockRequest(...args),
}));

import { scheduleAck, INITIAL_DELAY_MS, REPEAT_INTERVAL_MS } from './ack.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// Helper to create a mock HTTP response
function setupMockHttp(responseBody: string, statusCode = 200) {
  const mockRes = {
    statusCode,
    on: vi.fn((event: string, cb: (data?: Buffer) => void) => {
      if (event === 'data') {
        cb(Buffer.from(responseBody));
      }
      if (event === 'end') {
        cb();
      }
      return mockRes;
    }),
  };

  const mockReq = {
    on: vi.fn().mockReturnThis(),
    setTimeout: vi.fn().mockReturnThis(),
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  };

  mockRequest.mockImplementation((_opts: unknown, callback: (res: typeof mockRes) => void) => {
    // Call the callback asynchronously to simulate real behavior
    Promise.resolve().then(() => callback(mockRes));
    return mockReq;
  });

  return { mockReq, mockRes };
}

describe('scheduleAck', () => {
  it('returns a cancel function', () => {
    const cancel = scheduleAck('hello', 'Andy', vi.fn());
    expect(typeof cancel).toBe('function');
    cancel();
  });

  it('does not fire before INITIAL_DELAY_MS', () => {
    const sendFn = vi.fn();
    scheduleAck('hello', 'Andy', sendFn);

    vi.advanceTimersByTime(INITIAL_DELAY_MS - 1);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('fires initial ack after INITIAL_DELAY_MS', async () => {
    setupMockHttp(JSON.stringify({ content: [{ text: 'On it!' }] }));
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const cancel = scheduleAck('hello', 'Andy', sendFn);

    // Advance past initial delay and let microtasks resolve
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(sendFn).toHaveBeenCalledWith('On it!');
    cancel();
  });

  it('cancel before initial delay prevents ack from firing', async () => {
    setupMockHttp(JSON.stringify({ content: [{ text: 'On it!' }] }));
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const cancel = scheduleAck('hello', 'Andy', sendFn);

    vi.advanceTimersByTime(INITIAL_DELAY_MS / 2);
    cancel();
    await vi.runAllTimersAsync();

    expect(sendFn).not.toHaveBeenCalled();
  });

  it('cancel clears all timers', () => {
    const cancel = scheduleAck('hello', 'Andy', vi.fn());
    cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel after initial ack stops repeat interval', async () => {
    setupMockHttp(JSON.stringify({ content: [{ text: 'Working...' }] }));
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const cancel = scheduleAck('hello', 'Andy', sendFn);

    // Fire initial ack
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    const callCountAfterInitial = sendFn.mock.calls.length;
    cancel();

    // Advance past where repeat would fire
    await vi.advanceTimersByTimeAsync(REPEAT_INTERVAL_MS * 3);
    expect(sendFn.mock.calls.length).toBe(callCountAfterInitial);
  });
});

describe('generateAck (via scheduleAck)', () => {
  it('sends request to credential proxy on localhost', async () => {
    setupMockHttp(JSON.stringify({ content: [{ text: 'Got it' }] }));
    const sendFn = vi.fn().mockResolvedValue(undefined);
    scheduleAck('hello', 'Andy', sendFn);

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(mockRequest).toHaveBeenCalled();
    const opts = mockRequest.mock.calls[0][0];
    expect(opts.hostname).toBe('127.0.0.1');
    expect(opts.port).toBe(3001);
    expect(opts.path).toBe('/v1/messages');
    expect(opts.method).toBe('POST');
  });

  it('uses assistant name parameter in prompt', async () => {
    setupMockHttp(JSON.stringify({ content: [{ text: 'Hello' }] }));
    const sendFn = vi.fn().mockResolvedValue(undefined);
    scheduleAck('test message', 'Ren', sendFn);

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    const writeCall = mockRequest.mock.results[0]?.value;
    // The body is written via req.write - check the mock
    expect(mockRequest).toHaveBeenCalled();
    // Get the request object and check what was written
    const mockReq = mockRequest.mock.results[0]?.value;
    if (mockReq?.write?.mock?.calls?.[0]) {
      const body = JSON.parse(mockReq.write.mock.calls[0][0]);
      expect(body.messages[0].content).toContain('Ren');
      expect(body.messages[0].content).not.toContain('Andy');
    }
  });

  it('does not send ack when proxy returns empty response', async () => {
    setupMockHttp(JSON.stringify({ content: [] }));
    const sendFn = vi.fn().mockResolvedValue(undefined);
    scheduleAck('hello', 'Andy', sendFn);

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(sendFn).not.toHaveBeenCalled();
  });

  it('handles network errors gracefully', async () => {
    const mockReq = {
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'error') {
          Promise.resolve().then(cb);
        }
        return mockReq;
      }),
      setTimeout: vi.fn().mockReturnThis(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    mockRequest.mockReturnValue(mockReq);

    const sendFn = vi.fn().mockResolvedValue(undefined);
    scheduleAck('hello', 'Andy', sendFn);

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(sendFn).not.toHaveBeenCalled();
  });
});
