/**
 * <GeminaChat> — drop-in chat UI over Gemina Document Intelligence.
 *
 * Auth flows exclusively through a {@link GeminaTokenManager}: the component
 * asks it for a short-lived session token per turn and calls
 * `POST /v1/chat/query` through `@gemina/sdk`. It never sees — and cannot
 * accept — a Gemina API key (the token manager throws on API-key-shaped
 * credentials).
 *
 * SSR-safe: no `window`/`document` access at import time; styles are
 * injected on mount.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { GeminaClient } from '@gemina/sdk';
import type { ChatQueryOutDTO } from '@gemina/sdk';
import type { GeminaTokenManager } from './token-manager';
import { VERSION } from './version';

/** Visual theme. `"auto"` follows `prefers-color-scheme`. */
export type GeminaChatTheme = 'light' | 'dark' | 'auto';

/**
 * Text direction. `"auto"` flips the widget to RTL when the user's latest
 * message contains Hebrew, and lets each bubble resolve its own direction.
 */
export type GeminaChatDirection = 'ltr' | 'rtl' | 'auto';

export interface GeminaChatProps {
  /** Token source. Required — see {@link GeminaTokenManager}. */
  tokenManager: GeminaTokenManager;
  /** Gemina API base URL (default `https://api.gemina.co`). */
  baseUrl?: string;
  /**
   * Optional end-user id forwarded with each query. On the session-token
   * path the token's SIGNED scope always wins server-side — this is a
   * hint, not a security control.
   */
  endUserId?: string;
  /** Visual theme (default `"auto"`). */
  theme?: GeminaChatTheme;
  /** Text direction (default `"auto"`). */
  dir?: GeminaChatDirection;
  /** Input placeholder text. */
  placeholder?: string;
  /** Called with the cited `documentId` when a citation chip is clicked. */
  onCitationClick?: (documentId: string) => void;
  /** Extra class name(s) for the root element (e.g. to override CSS vars). */
  className?: string;
}

interface UserMessage {
  id: number;
  role: 'user';
  text: string;
}

interface AssistantMessage {
  id: number;
  role: 'assistant';
  text: string;
  citations: string[];
  confident: boolean;
}

interface ErrorMessage {
  id: number;
  role: 'error';
  text: string;
  /** Present only when a retry is offered; holds the original user text. */
  retryText?: string;
}

type ChatMessage = UserMessage | AssistantMessage | ErrorMessage;

/** `Omit` that distributes over each member of a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type ChatMessageInput = DistributiveOmit<ChatMessage, 'id'>;

/** Hebrew Unicode block (U+0590–U+05FF). */
const HEBREW_RE = /[\u0590-\u05FF]/;

/**
 * Extract an HTTP status from a thrown value by shape rather than
 * `instanceof ResponseError` — robust against duplicated `@gemina/sdk`
 * copies in a bundle (class identity is not shared across copies).
 */
function httpStatus(error: unknown): number | undefined {
  if (error !== null && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: unknown }).response;
    if (
      response !== null &&
      typeof response === 'object' &&
      typeof (response as { status?: unknown }).status === 'number'
    ) {
      return (response as { status: number }).status;
    }
  }
  return undefined;
}

const SESSION_EXPIRED_TEXT = 'Session expired — please reload the page or sign in again.';
const RATE_LIMIT_TEXT = "You're sending messages too quickly — try again shortly.";
const PLAN_GATE_TEXT = "Document Intelligence isn't enabled on this plan.";
const GENERIC_ERROR_TEXT = "Something went wrong and your message wasn't answered.";

/**
 * The API reports citations as an array of `documentId` strings; normalize
 * defensively so `{ documentId }` objects also work if the shape evolves.
 */
function normalizeCitations(citations: unknown): string[] {
  if (!Array.isArray(citations)) {
    return [];
  }
  const ids: string[] = [];
  for (const item of citations) {
    if (typeof item === 'string' && item.length > 0) {
      ids.push(item);
    } else if (
      item !== null &&
      typeof item === 'object' &&
      typeof (item as { documentId?: unknown }).documentId === 'string'
    ) {
      ids.push((item as { documentId: string }).documentId);
    }
  }
  return ids;
}

// --- Styles -----------------------------------------------------------------
// Hand-rolled, no UI deps. Everything is scoped under .gemina-chat and driven
// by CSS custom properties so host apps can re-theme without touching the DOM.

const DARK_VARS = `
  --gemina-chat-bg: #101418;
  --gemina-chat-fg: #e6e9ee;
  --gemina-chat-border: #2a323c;
  --gemina-chat-accent: #4c8dff;
  --gemina-chat-accent-fg: #ffffff;
  --gemina-chat-assistant-bg: #1c232b;
  --gemina-chat-assistant-fg: #e6e9ee;
  --gemina-chat-muted: #98a2b3;
  --gemina-chat-error: #f97066;
  --gemina-chat-low-confidence: #f7b27a;
`;

const CHAT_CSS = `
.gemina-chat {
  --gemina-chat-bg: #ffffff;
  --gemina-chat-fg: #1a1d21;
  --gemina-chat-border: #d9dce1;
  --gemina-chat-accent: #2f6fed;
  --gemina-chat-accent-fg: #ffffff;
  --gemina-chat-assistant-bg: #f2f4f7;
  --gemina-chat-assistant-fg: #1a1d21;
  --gemina-chat-muted: #667085;
  --gemina-chat-error: #b42318;
  --gemina-chat-low-confidence: #b54708;
  --gemina-chat-radius: 10px;
  --gemina-chat-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;

  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-height: 320px;
  max-height: 600px;
  background: var(--gemina-chat-bg);
  color: var(--gemina-chat-fg);
  border: 1px solid var(--gemina-chat-border);
  border-radius: var(--gemina-chat-radius);
  font-family: var(--gemina-chat-font);
  font-size: 14px;
  line-height: 1.5;
}
.gemina-chat *, .gemina-chat *::before, .gemina-chat *::after { box-sizing: border-box; }
.gemina-chat--dark { ${DARK_VARS} }
@media (prefers-color-scheme: dark) {
  .gemina-chat--auto { ${DARK_VARS} }
}
.gemina-chat__log {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.gemina-chat__msg {
  max-width: 85%;
  padding: 8px 12px;
  border-radius: var(--gemina-chat-radius);
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
.gemina-chat__msg--user {
  align-self: flex-end;
  background: var(--gemina-chat-accent);
  color: var(--gemina-chat-accent-fg);
}
.gemina-chat--rtl .gemina-chat__msg--user, .gemina-chat[dir="rtl"] .gemina-chat__msg--user {
  align-self: flex-start;
}
.gemina-chat--rtl .gemina-chat__msg--assistant, .gemina-chat[dir="rtl"] .gemina-chat__msg--assistant {
  align-self: flex-end;
}
.gemina-chat__msg--assistant {
  align-self: flex-start;
  background: var(--gemina-chat-assistant-bg);
  color: var(--gemina-chat-assistant-fg);
}
.gemina-chat__msg--low-confidence {
  border: 1px dashed var(--gemina-chat-low-confidence);
}
.gemina-chat__low-confidence-note {
  margin-top: 6px;
  font-size: 12px;
  color: var(--gemina-chat-low-confidence);
}
.gemina-chat__citations {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.gemina-chat__citation {
  font: inherit;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--gemina-chat-border);
  background: transparent;
  color: var(--gemina-chat-accent);
  cursor: pointer;
}
.gemina-chat__citation:hover { border-color: var(--gemina-chat-accent); }
.gemina-chat__msg--error {
  align-self: flex-start;
  background: transparent;
  border: 1px solid var(--gemina-chat-error);
  color: var(--gemina-chat-error);
}
.gemina-chat__retry {
  font: inherit;
  font-size: 12px;
  margin-top: 6px;
  display: block;
  padding: 2px 10px;
  border-radius: var(--gemina-chat-radius);
  border: 1px solid var(--gemina-chat-error);
  background: transparent;
  color: var(--gemina-chat-error);
  cursor: pointer;
}
.gemina-chat__typing {
  align-self: flex-start;
  color: var(--gemina-chat-muted);
  font-size: 12px;
  padding: 0 4px;
}
.gemina-chat__composer {
  display: flex;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--gemina-chat-border);
}
.gemina-chat__input {
  flex: 1;
  resize: none;
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid var(--gemina-chat-border);
  border-radius: var(--gemina-chat-radius);
  padding: 8px 10px;
  min-height: 38px;
}
.gemina-chat__input:focus {
  outline: 2px solid var(--gemina-chat-accent);
  outline-offset: -1px;
}
.gemina-chat__send {
  font: inherit;
  align-self: flex-end;
  border: none;
  border-radius: var(--gemina-chat-radius);
  background: var(--gemina-chat-accent);
  color: var(--gemina-chat-accent-fg);
  padding: 8px 16px;
  cursor: pointer;
}
.gemina-chat__send:disabled { opacity: 0.5; cursor: default; }
`;

const STYLE_ATTR = 'data-gemina-chat';

/**
 * Inject the widget stylesheet once per document (idempotent across
 * instances; intentionally not removed on unmount so sibling instances and
 * quick remounts never flash unstyled).
 */
function ensureStylesInjected(): void {
  if (typeof document === 'undefined') {
    return;
  }
  if (document.head.querySelector(`style[${STYLE_ATTR}]`) !== null) {
    return;
  }
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTR, VERSION);
  style.textContent = CHAT_CSS;
  document.head.appendChild(style);
}

/**
 * Embeddable Gemina Document Intelligence chat.
 *
 * ```tsx
 * <GeminaChat
 *   tokenManager={tokenManager}
 *   onCitationClick={(documentId) => openDocument(documentId)}
 * />
 * ```
 */
export function GeminaChat(props: GeminaChatProps): React.JSX.Element {
  const {
    tokenManager,
    baseUrl,
    endUserId,
    theme = 'auto',
    dir = 'auto',
    placeholder = 'Ask about your documents…',
    onCitationClick,
    className,
  } = props;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const nextIdRef = useRef(0);
  const mountedRef = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    ensureStylesInjected();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Keep the newest message in view.
  useEffect(() => {
    const log = logRef.current;
    if (log !== null) {
      log.scrollTop = log.scrollHeight;
    }
  }, [messages, busy]);

  const appendMessage = useCallback((message: ChatMessageInput) => {
    const id = nextIdRef.current++;
    setMessages((prev) => [...prev, { ...message, id }]);
  }, []);

  const chatOnce = useCallback(
    (token: string, message: string): Promise<ChatQueryOutDTO> => {
      const client = GeminaClient.withSessionToken(token, baseUrl);
      return client.chat.chatQuery({ chatQueryInDTO: { message, endUserId } });
    },
    [baseUrl, endUserId],
  );

  /** One turn, with the mandated 401-invalidate-retry-once behavior. */
  const queryWithRetry = useCallback(
    async (message: string): Promise<ChatQueryOutDTO> => {
      const token = await tokenManager.getToken();
      try {
        return await chatOnce(token, message);
      } catch (error) {
        if (httpStatus(error) !== 401) {
          throw error;
        }
        // Token likely expired mid-session: drop it, re-mint via the
        // tenant backend, retry exactly once. A second 401 propagates.
        tokenManager.invalidate();
        const freshToken = await tokenManager.getToken();
        return await chatOnce(freshToken, message);
      }
    },
    [tokenManager, chatOnce],
  );

  const performSend = useCallback(
    async (text: string) => {
      setBusy(true);
      try {
        const result = await queryWithRetry(text);
        if (!mountedRef.current) {
          return;
        }
        appendMessage({
          role: 'assistant',
          text: result.answer,
          citations: normalizeCitations(result.citations),
          confident: result.confident !== false,
        });
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }
        const status = httpStatus(error);
        if (status === 401) {
          appendMessage({ role: 'error', text: SESSION_EXPIRED_TEXT });
        } else if (status === 429) {
          appendMessage({ role: 'error', text: RATE_LIMIT_TEXT });
        } else if (status === 402 || status === 403) {
          appendMessage({ role: 'error', text: PLAN_GATE_TEXT });
        } else {
          appendMessage({ role: 'error', text: GENERIC_ERROR_TEXT, retryText: text });
        }
      } finally {
        if (mountedRef.current) {
          setBusy(false);
        }
      }
    },
    [queryWithRetry, appendMessage],
  );

  const submitDraft = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0 || busy) {
      return;
    }
    setDraft('');
    appendMessage({ role: 'user', text });
    void performSend(text);
  }, [draft, busy, appendMessage, performSend]);

  const retryMessage = useCallback(
    (failed: ErrorMessage) => {
      if (busy || failed.retryText === undefined) {
        return;
      }
      const text = failed.retryText;
      // Replace the error entry; the original user bubble is still there.
      setMessages((prev) => prev.filter((message) => message.id !== failed.id));
      void performSend(text);
    },
    [busy, performSend],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submitDraft();
      }
    },
    [submitDraft],
  );

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submitDraft();
    },
    [submitDraft],
  );

  // dir="auto": follow the user's latest message (Hebrew → RTL); individual
  // bubbles additionally resolve their own direction via dir="auto".
  let effectiveDir: 'ltr' | 'rtl';
  if (dir === 'auto') {
    let lastUserText = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message !== undefined && message.role === 'user') {
        lastUserText = message.text;
        break;
      }
    }
    effectiveDir = HEBREW_RE.test(lastUserText) ? 'rtl' : 'ltr';
  } else {
    effectiveDir = dir;
  }
  const bubbleDir = dir === 'auto' ? 'auto' : undefined;

  const rootClassName = [
    'gemina-chat',
    `gemina-chat--${theme}`,
    effectiveDir === 'rtl' ? 'gemina-chat--rtl' : '',
    className ?? '',
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  return (
    <div className={rootClassName} dir={effectiveDir}>
      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-busy={busy}
        aria-label="Chat messages"
        className="gemina-chat__log"
      >
        {messages.map((message) => {
          if (message.role === 'user') {
            return (
              <div
                key={message.id}
                className="gemina-chat__msg gemina-chat__msg--user"
                dir={bubbleDir}
              >
                {message.text}
              </div>
            );
          }
          if (message.role === 'assistant') {
            const lowConfidence = !message.confident;
            return (
              <div
                key={message.id}
                className={
                  'gemina-chat__msg gemina-chat__msg--assistant' +
                  (lowConfidence ? ' gemina-chat__msg--low-confidence' : '')
                }
                dir={bubbleDir}
              >
                {message.text}
                {lowConfidence && (
                  <div className="gemina-chat__low-confidence-note">
                    Low confidence — please verify against the cited documents.
                  </div>
                )}
                {message.citations.length > 0 && (
                  <div className="gemina-chat__citations">
                    {message.citations.map((documentId, index) => (
                      <button
                        key={`${documentId}-${index}`}
                        type="button"
                        className="gemina-chat__citation"
                        title={`Open document ${documentId}`}
                        onClick={() => onCitationClick?.(documentId)}
                      >
                        {documentId}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          return (
            <div
              key={message.id}
              role="alert"
              className="gemina-chat__msg gemina-chat__msg--error"
            >
              {message.text}
              {message.retryText !== undefined && (
                <button
                  type="button"
                  className="gemina-chat__retry"
                  onClick={() => retryMessage(message)}
                >
                  Retry
                </button>
              )}
            </div>
          );
        })}
        {busy && <div className="gemina-chat__typing">Thinking…</div>}
      </div>
      <form className="gemina-chat__composer" onSubmit={handleSubmit}>
        <textarea
          className="gemina-chat__input"
          aria-label="Chat message"
          rows={1}
          value={draft}
          placeholder={placeholder}
          dir={bubbleDir}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="submit"
          className="gemina-chat__send"
          aria-label="Send message"
          disabled={busy || draft.trim().length === 0}
        >
          Send
        </button>
      </form>
    </div>
  );
}
