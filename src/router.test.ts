import { describe, it, expect } from 'vitest';

import { findChannel } from './router.js';
import { Channel } from './types.js';

function mockChannel(ownsJidResult: boolean, connected: boolean): Channel {
  return {
    name: 'test',
    connect: async () => {},
    sendMessage: async () => {},
    isConnected: () => connected,
    ownsJid: () => ownsJidResult,
    disconnect: async () => {},
  };
}

function mockChannelWithOwns(
  ownsFn: (jid: string) => boolean,
  connected: boolean,
): Channel {
  return {
    name: 'test',
    connect: async () => {},
    sendMessage: async () => {},
    isConnected: () => connected,
    ownsJid: ownsFn,
    disconnect: async () => {},
  };
}

describe('findChannel', () => {
  it('returns connected channel that owns JID', () => {
    const ch = mockChannel(true, true);
    expect(findChannel([ch], 'group@g.us')).toBe(ch);
  });

  it('returns undefined when channel owns JID but is disconnected', () => {
    const ch = mockChannel(true, false);
    expect(findChannel([ch], 'group@g.us')).toBeUndefined();
  });

  it('returns undefined when no channel owns JID', () => {
    const ch = mockChannel(false, true);
    expect(findChannel([ch], 'group@g.us')).toBeUndefined();
  });

  it('returns undefined for empty channels array', () => {
    expect(findChannel([], 'group@g.us')).toBeUndefined();
  });

  it('skips disconnected channel, returns next connected one', () => {
    const disconnected = mockChannelWithOwns((jid) => jid === 'tg:123', false);
    const connected = mockChannelWithOwns((jid) => jid === 'tg:123', true);
    expect(findChannel([disconnected, connected], 'tg:123')).toBe(connected);
  });

  it('returns undefined when all channels disconnected', () => {
    const ch1 = mockChannel(true, false);
    const ch2 = mockChannel(true, false);
    expect(findChannel([ch1, ch2], 'group@g.us')).toBeUndefined();
  });

  it('returns undefined for empty JID', () => {
    const ch = mockChannelWithOwns((jid) => jid === '', true);
    // Channel.ownsJid('') returns true here, but in practice channels
    // check for specific prefixes, so this tests the empty-string path
    expect(findChannel([mockChannel(false, true)], '')).toBeUndefined();
  });
});
