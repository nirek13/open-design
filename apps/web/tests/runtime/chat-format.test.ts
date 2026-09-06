import { describe, expect, it } from 'vitest';
import { parseChatBlocks, parseChatInline, parseRemindWhen, parseSlashCommand } from '../../src/runtime/chat-format';

describe('chat-format', () => {
  it('parses Slack-style inline marks and mentions', () => {
    const parts = parseChatInline('hi *bold* _i_ ~s~ `code` @ada');
    expect(parts.map((part) => part.kind)).toEqual([
      'text', 'bold', 'text', 'italic', 'text', 'strike', 'text', 'code', 'text', 'mention',
    ]);
  });

  it('parses quotes, lists, and fences', () => {
    const blocks = parseChatBlocks('> note\n- one\n```\ncode\n```');
    expect(blocks.map((block) => block.kind)).toEqual(['quote', 'list', 'code']);
  });

  it('parses slash commands', () => {
    expect(parseSlashCommand('/mute')).toEqual({ name: 'mute', rest: '' });
    expect(parseSlashCommand('/status coffee')).toEqual({ name: 'status', rest: 'coffee' });
    expect(parseSlashCommand('/topic hello')).toEqual({ name: 'topic', rest: 'hello' });
    expect(parseSlashCommand('not a command')).toBeNull();
  });

  it('parses remind offsets', () => {
    expect(parseRemindWhen('20m', 0)).toBe(20 * 60_000);
    expect(parseRemindWhen('tomorrow', Date.UTC(2026, 0, 1, 12))).toBeGreaterThan(Date.UTC(2026, 0, 1, 12));
  });
});
