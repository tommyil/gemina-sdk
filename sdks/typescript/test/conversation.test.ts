import { describe, it, expect, vi } from 'vitest';
import { GeminaClient, GeminaChatConversation } from '../src/helpers';
import type { ChatApi } from '../src/generated';

/** A ChatApi test double exposing only what the conversation helper calls. */
function fakeChat() {
  const chatQuery = vi.fn();
  const deleteChatSession = vi.fn().mockResolvedValue(undefined);
  return { chatQuery, deleteChatSession } as unknown as ChatApi & {
    chatQuery: ReturnType<typeof vi.fn>;
    deleteChatSession: ReturnType<typeof vi.fn>;
  };
}

function makeConversation(endUserId?: string) {
  const chat = fakeChat();
  const client = new GeminaClient('key', undefined, { apis: { chat } });
  return { chat, convo: client.conversation({ endUserId }) };
}

describe('GeminaChatConversation', () => {
  it('exposes a conversation() factory returning the helper', () => {
    const { convo } = makeConversation();
    expect(convo).toBeInstanceOf(GeminaChatConversation);
    expect(convo.sessionId).toBeUndefined();
  });

  it('omits sessionId on the first turn and threads it on every following turn', async () => {
    const { chat, convo } = makeConversation('eu-1');
    chat.chatQuery
      .mockResolvedValueOnce({ answer: 'first', sessionId: 'sess-9' })
      .mockResolvedValueOnce({ answer: 'second', sessionId: 'sess-9' });

    const first = await convo.send('turn one');
    expect(first.answer).toBe('first');
    expect(convo.sessionId).toBe('sess-9');
    expect(chat.chatQuery).toHaveBeenNthCalledWith(1, {
      chatQueryInDTO: { message: 'turn one', endUserId: 'eu-1' },
    });

    await convo.send('turn two');
    expect(chat.chatQuery).toHaveBeenNthCalledWith(2, {
      chatQueryInDTO: { message: 'turn two', endUserId: 'eu-1', sessionId: 'sess-9' },
    });
  });

  it('reset() forgets the session so the next turn starts fresh', async () => {
    const { chat, convo } = makeConversation();
    chat.chatQuery
      .mockResolvedValueOnce({ answer: 'a', sessionId: 'sess-a' })
      .mockResolvedValueOnce({ answer: 'b', sessionId: 'sess-b' });

    await convo.send('one');
    expect(convo.sessionId).toBe('sess-a');

    convo.reset();
    expect(convo.sessionId).toBeUndefined();

    await convo.send('two');
    // No sessionId carried after a reset — a brand-new conversation.
    expect(chat.chatQuery).toHaveBeenNthCalledWith(2, {
      chatQueryInDTO: { message: 'two', endUserId: undefined },
    });
    expect(convo.sessionId).toBe('sess-b');
  });

  it('delete() removes the session server-side and forgets it locally', async () => {
    const { chat, convo } = makeConversation();
    chat.chatQuery.mockResolvedValueOnce({ answer: 'x', sessionId: 'sess-x' });

    await convo.send('hi');
    await convo.delete();

    expect(chat.deleteChatSession).toHaveBeenCalledWith({ sessionId: 'sess-x' });
    expect(convo.sessionId).toBeUndefined();
  });

  it('delete() is a no-op before any turn (nothing to delete)', async () => {
    const { chat, convo } = makeConversation();
    await convo.delete();
    expect(chat.deleteChatSession).not.toHaveBeenCalled();
  });
});
