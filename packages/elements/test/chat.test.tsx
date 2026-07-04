/**
 * <GeminaChat> — offline component tests with a mocked @gemina/sdk.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminaChat } from '../src/chat';
import { GeminaTokenManager } from '../src/token-manager';

const { chatQuery, withSessionToken } = vi.hoisted(() => {
  const chatQuery = vi.fn();
  const withSessionToken = vi.fn((_token: string, _baseUrl?: string) => ({
    chat: { chatQuery },
  }));
  return { chatQuery, withSessionToken };
});

vi.mock('@gemina/sdk', () => ({
  GeminaClient: { withSessionToken },
}));

/** A ResponseError-shaped rejection (public `response.status`, like the SDK's). */
function httpError(status: number): Error {
  const error = new Error(`Response returned an error code (${status})`);
  (error as unknown as { response: { status: number } }).response = { status };
  return error;
}

function answer(text: string, overrides: Record<string, unknown> = {}) {
  return { answer: text, citations: [], confident: true, ...overrides };
}

function makeManager() {
  let n = 0;
  const fetchToken = vi.fn(async () => ({
    token: `eyJhbGciOiJIUzI1NiJ9.payload${++n}.signature`,
    expiresIn: 900,
  }));
  return { tokenManager: new GeminaTokenManager({ fetchToken }), fetchToken };
}

function renderChat(extraProps: Partial<Parameters<typeof GeminaChat>[0]> = {}) {
  const { tokenManager, fetchToken } = makeManager();
  const utils = render(<GeminaChat tokenManager={tokenManager} {...extraProps} />);
  return { ...utils, tokenManager, fetchToken };
}

async function sendMessage(text: string) {
  fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
}

afterEach(() => {
  cleanup();
  chatQuery.mockReset();
  withSessionToken.mockClear();
});

describe('GeminaChat — rendering', () => {
  it('renders a labelled input, send button, and an accessible message log', () => {
    renderChat({ placeholder: 'Ask me' });

    expect(screen.getByLabelText('Chat message')).toBeTruthy();
    expect(screen.getByPlaceholderText('Ask me')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
    const log = screen.getByRole('log');
    expect(log.getAttribute('aria-busy')).toBe('false');
  });

  it('injects its stylesheet once, with a stable data attribute', () => {
    renderChat();
    renderChat();
    const styles = document.head.querySelectorAll('style[data-gemina-chat]');
    expect(styles.length).toBe(1);
    expect(styles[0]?.textContent).toContain('.gemina-chat');
  });
});

describe('GeminaChat — sending a message', () => {
  it('shows the user turn, the answer, and clickable citation chips', async () => {
    chatQuery.mockResolvedValueOnce(
      answer('You spent 4,200 ILS at Acme.', { citations: ['doc-1', 'doc-2'] }),
    );
    const onCitationClick = vi.fn();
    const { fetchToken } = renderChat({
      baseUrl: 'https://api.example.test',
      endUserId: 'end-user-7',
      onCitationClick,
    });

    await sendMessage('How much did I spend at Acme?');

    expect(await screen.findByText('You spent 4,200 ILS at Acme.')).toBeTruthy();
    expect(screen.getByText('How much did I spend at Acme?')).toBeTruthy();

    // Token from the manager (a JWT, never an API key), base URL forwarded.
    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(withSessionToken).toHaveBeenCalledTimes(1);
    const [token, baseUrl] = withSessionToken.mock.calls[0] ?? [];
    expect(token?.split('.')).toHaveLength(3);
    expect(baseUrl).toBe('https://api.example.test');
    expect(chatQuery).toHaveBeenCalledWith({
      chatQueryInDTO: { message: 'How much did I spend at Acme?', endUserId: 'end-user-7' },
    });

    // Citation chips render and surface documentId on click.
    fireEvent.click(screen.getByRole('button', { name: /doc-1/ }));
    expect(onCitationClick).toHaveBeenCalledWith('doc-1');
    expect(screen.getByRole('button', { name: /doc-2/ })).toBeTruthy();
  });

  it('submits on Enter and inserts a newline (no submit) on Shift+Enter', async () => {
    chatQuery.mockResolvedValueOnce(answer('ok'));
    renderChat();
    const input = screen.getByLabelText('Chat message');

    fireEvent.change(input, { target: { value: 'first line' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(chatQuery).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('ok')).toBeTruthy();
    expect(chatQuery).toHaveBeenCalledTimes(1);
  });

  it('marks a confident=false answer with the low-confidence treatment', async () => {
    chatQuery.mockResolvedValueOnce(
      answer('Maybe around 12 invoices.', { confident: false }),
    );
    const { container } = renderChat();

    await sendMessage('How many invoices?');

    await screen.findByText('Maybe around 12 invoices.');
    const bubble = container.querySelector('.gemina-chat__msg--low-confidence');
    expect(bubble).toBeTruthy();
    expect(screen.getByText(/low confidence/i)).toBeTruthy();
  });

  it('accepts citations given as objects with documentId (defensive shape)', async () => {
    chatQuery.mockResolvedValueOnce(
      answer('Cited.', { citations: [{ documentId: 'doc-obj-1' }] }),
    );
    const onCitationClick = vi.fn();
    renderChat({ onCitationClick });

    await sendMessage('cite me');
    await screen.findByText('Cited.');

    fireEvent.click(screen.getByRole('button', { name: /doc-obj-1/ }));
    expect(onCitationClick).toHaveBeenCalledWith('doc-obj-1');
  });
});

describe('GeminaChat — 401 handling (invalidate + retry once)', () => {
  it('on 401: invalidates, re-mints, retries once, and shows the answer', async () => {
    chatQuery
      .mockRejectedValueOnce(httpError(401))
      .mockResolvedValueOnce(answer('fresh-token answer'));
    const { fetchToken } = renderChat();

    await sendMessage('hello');

    expect(await screen.findByText('fresh-token answer')).toBeTruthy();
    // Two mints (initial + post-invalidate), two clients, different tokens.
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(withSessionToken).toHaveBeenCalledTimes(2);
    const firstToken = withSessionToken.mock.calls[0]?.[0];
    const secondToken = withSessionToken.mock.calls[1]?.[0];
    expect(firstToken).not.toBe(secondToken);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('on a second consecutive 401: shows "Session expired" and stops retrying', async () => {
    chatQuery.mockRejectedValueOnce(httpError(401)).mockRejectedValueOnce(httpError(401));
    renderChat();

    await sendMessage('hello');

    expect(await screen.findByText(/session expired/i)).toBeTruthy();
    expect(chatQuery).toHaveBeenCalledTimes(2); // exactly one retry
  });
});

describe('GeminaChat — error states', () => {
  it('429 → human-readable rate-limit message', async () => {
    chatQuery.mockRejectedValueOnce(httpError(429));
    renderChat();

    await sendMessage('too fast');

    expect(
      await screen.findByText(/sending messages too quickly — try again shortly/i),
    ).toBeTruthy();
  });

  it.each([402, 403])('%i → plan-gate message', async (status) => {
    chatQuery.mockRejectedValueOnce(httpError(status));
    renderChat();

    await sendMessage('am I entitled?');

    expect(
      await screen.findByText(/Document Intelligence isn't enabled on this plan/i),
    ).toBeTruthy();
  });

  it('other failures → generic message with a Retry that resends the last message', async () => {
    chatQuery.mockRejectedValueOnce(httpError(500));
    renderChat();

    await sendMessage('flaky question');
    expect(await screen.findByText(/something went wrong/i)).toBeTruthy();

    chatQuery.mockResolvedValueOnce(answer('recovered answer'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('recovered answer')).toBeTruthy();
    // The error entry is gone and the user bubble was NOT duplicated.
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
    expect(screen.getAllByText('flaky question')).toHaveLength(1);
    expect(chatQuery).toHaveBeenLastCalledWith({
      chatQueryInDTO: { message: 'flaky question', endUserId: undefined },
    });
  });

  it('a network-level failure (no response) also maps to the generic message', async () => {
    chatQuery.mockRejectedValueOnce(new TypeError('fetch failed'));
    renderChat();

    await sendMessage('offline?');

    expect(await screen.findByText(/something went wrong/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('GeminaChat — direction handling', () => {
  it('dir="auto" flips the widget to RTL when the user writes Hebrew', async () => {
    chatQuery.mockResolvedValue(answer('42'));
    const { container } = renderChat();
    const root = container.querySelector('.gemina-chat');

    expect(root?.getAttribute('dir')).toBe('ltr');

    await sendMessage('כמה חשבוניות יש לי?');
    await screen.findByText('42');
    expect(root?.getAttribute('dir')).toBe('rtl');
  });

  it('an explicit dir prop wins over auto-detection', async () => {
    chatQuery.mockResolvedValue(answer('42'));
    const { container } = renderChat({ dir: 'ltr' });

    await sendMessage('כמה חשבוניות יש לי?');
    await screen.findByText('42');
    expect(container.querySelector('.gemina-chat')?.getAttribute('dir')).toBe('ltr');
  });
});
