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
 * The response-like object carried by a thrown transport error. We pull it off
 * by shape rather than `instanceof ResponseError` — robust against duplicated
 * `@gemina/sdk` copies in a bundle (class identity is not shared across
 * copies). On the fetch transport this is the raw `Response`, so `status`,
 * `headers`, and the JSON body are all reachable from here.
 */
interface ResponseLike {
  status?: number;
  headers?: { get?: (name: string) => string | null };
  json?: () => Promise<unknown>;
  clone?: () => ResponseLike;
}

function getResponseLike(error: unknown): ResponseLike | undefined {
  if (error !== null && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: unknown }).response;
    if (response !== null && typeof response === 'object') {
      return response as ResponseLike;
    }
  }
  return undefined;
}

/** Extract an HTTP status from a thrown value, or `undefined`. */
function httpStatus(error: unknown): number | undefined {
  const status = getResponseLike(error)?.status;
  return typeof status === 'number' ? status : undefined;
}

// Stable backend error codes. These survive production's `detail`-stripping
// (see the chat-pricing handoff); we switch on HTTP status first and refine
// with these where the same status can mean two different things.
const ERR_CHAT_QUOTA_EXCEEDED = 'CHAT_QUOTA_EXCEEDED';
const ERR_DI_NOT_IN_PLAN = 'DOCUMENT_INTELLIGENCE_NOT_IN_PLAN';
const ERR_UNPROCESSABLE = 'UNPROCESSABLE_ERROR';
const ERR_BAD_GATEWAY = 'BAD_GATEWAY_ERROR';
// A conversation id that the server no longer knows (24h idle TTL, explicit
// reset, or end-user scope drift). A turn that CARRIED a session and 404s is
// this by construction — the chat/query handler raises 404 for nothing else —
// so the component drops the id and restarts the conversation transparently.
const ERR_CHAT_SESSION_NOT_FOUND = 'CHAT_SESSION_NOT_FOUND';

interface ChatErrorInfo {
  status: number | undefined;
  errorCode: string | undefined;
  /** Human-readable server fallback (`errors[0].description`). */
  description: string | undefined;
  /** Whole seconds until reset, from the `Retry-After` header (429). */
  retryAfterSeconds: number | undefined;
}

/**
 * Read what the backend actually sent on an error. Only the HTTP status, the
 * stable `errors[0].error_code` / `description`, and the `Retry-After` header
 * are reliable across environments — production strips `errors[0].detail`, so
 * we never touch it. The fetch body can be read once, so we clone defensively;
 * if that fails (non-JSON, empty, or already consumed) the status still stands.
 */
async function readChatError(error: unknown): Promise<ChatErrorInfo> {
  const response = getResponseLike(error);
  const info: ChatErrorInfo = {
    status: typeof response?.status === 'number' ? response.status : undefined,
    errorCode: undefined,
    description: undefined,
    retryAfterSeconds: undefined,
  };
  if (response === undefined) {
    return info;
  }

  const rawRetryAfter = response.headers?.get?.('retry-after');
  if (rawRetryAfter !== null && rawRetryAfter !== undefined) {
    const seconds = Number(rawRetryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      info.retryAfterSeconds = seconds;
    }
  }

  let body: unknown;
  try {
    const source = typeof response.clone === 'function' ? response.clone() : response;
    body = typeof source.json === 'function' ? await source.json() : undefined;
  } catch {
    body = undefined;
  }
  if (body !== null && typeof body === 'object') {
    const errors = (body as { errors?: unknown }).errors;
    if (
      Array.isArray(errors) &&
      errors.length > 0 &&
      errors[0] !== null &&
      typeof errors[0] === 'object'
    ) {
      const first = errors[0] as { error_code?: unknown; description?: unknown };
      if (typeof first.error_code === 'string') {
        info.errorCode = first.error_code;
      }
      if (typeof first.description === 'string') {
        info.description = first.description;
      }
    }
  }
  return info;
}

const SESSION_EXPIRED_TEXT = 'Session expired — please reload the page or sign in again.';
const CONVERSATION_RESET_TEXT =
  'This conversation is no longer available — send your message again to start a new one.';
const RATE_LIMIT_TEXT = "You're sending messages too quickly — try again shortly.";
const PLAN_GATE_TEXT = "Chat isn't included in your plan.";
const UNANSWERABLE_TEXT = "We couldn't answer that. Try rephrasing your question.";
const SERVICE_UNAVAILABLE_TEXT = 'The chat service is temporarily unavailable. Please try again.';
const GENERIC_ERROR_TEXT = "Something went wrong and your message wasn't answered.";

/** Friendly "resets in about N days/hours/minutes" from Retry-After seconds. */
function formatResetHint(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return 'at the next billing cycle';
  }
  const days = Math.round(seconds / 86400);
  if (days >= 1) {
    return `in about ${days} day${days === 1 ? '' : 's'}`;
  }
  const hours = Math.round(seconds / 3600);
  if (hours >= 1) {
    return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `in about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Map a chat error to the bubble we render. Switches on HTTP status, refined by
 * the stable backend `error_code`. `retryText` is set only when resending the
 * same text could plausibly succeed — never for quota / plan / validation
 * outcomes, where an identical retry would just fail the same way.
 */
function describeChatError(info: ChatErrorInfo, originalText: string): ChatMessageInput {
  const { status, errorCode } = info;

  // Over the included cap AND out of credits — the chat is blocked. Retrying
  // won't help; point at the reset time from the Retry-After header.
  if (status === 429 && errorCode === ERR_CHAT_QUOTA_EXCEEDED) {
    return {
      role: 'error',
      text: `You've used your included chats and are out of credits. Included chats reset ${formatResetHint(
        info.retryAfterSeconds,
      )}.`,
    };
  }
  // Any other 429 is a transient rate limit — a retry after a moment is fine.
  if (status === 429) {
    return { role: 'error', text: RATE_LIMIT_TEXT, retryText: originalText };
  }
  // Document Intelligence not in the plan/contract. NOT an auth failure.
  if (status === 402 || status === 403 || errorCode === ERR_DI_NOT_IN_PLAN) {
    return { role: 'error', text: PLAN_GATE_TEXT };
  }
  // Session expired — only surfaces after the 401-invalidate-retry-once path
  // has already failed a second time.
  if (status === 401) {
    return { role: 'error', text: SESSION_EXPIRED_TEXT };
  }
  // A stale conversation id that slipped past the transparent restart (the
  // restart only fires for a turn that carried a session). Resending starts a
  // fresh conversation, so offer a Retry rather than a dead-end error.
  if (status === 404 || errorCode === ERR_CHAT_SESSION_NOT_FOUND) {
    return { role: 'error', text: CONVERSATION_RESET_TEXT, retryText: originalText };
  }
  // The question couldn't be answered (e.g. no searchable text). Expected, not
  // a server error — invite a rephrase rather than a blind retry.
  if (status === 422 || errorCode === ERR_UNPROCESSABLE) {
    return { role: 'error', text: UNANSWERABLE_TEXT };
  }
  // Chat backend timed out / unreachable — transient, offer retry.
  if (status === 502 || errorCode === ERR_BAD_GATEWAY) {
    return { role: 'error', text: SERVICE_UNAVAILABLE_TEXT, retryText: originalText };
  }
  // Anything else (incl. 500): prefer the server's description if it sent one.
  return {
    role: 'error',
    text: info.description ?? GENERIC_ERROR_TEXT,
    retryText: originalText,
  };
}

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
.gemina-chat__header {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  flex: 0 0 auto;
  padding: 6px 10px;
  border-bottom: 1px solid var(--gemina-chat-border);
}
.gemina-chat__newchat {
  font: inherit;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: var(--gemina-chat-radius);
  border: 1px solid var(--gemina-chat-border);
  background: transparent;
  color: var(--gemina-chat-accent);
  cursor: pointer;
}
.gemina-chat__newchat:hover:not(:disabled) { border-color: var(--gemina-chat-accent); }
.gemina-chat__newchat:disabled { opacity: 0.5; cursor: default; }
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
  // The conversation id (server-issued) that gives the chat memory across
  // turns. Held in a ref, not state: it changes per turn but must never
  // trigger a re-render, and the send flow reads its latest value directly.
  // Distinct from the auth session TOKEN the token manager holds.
  const sessionIdRef = useRef<string | undefined>(undefined);

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
      const sessionId = sessionIdRef.current;
      return client.chat.chatQuery({
        // Thread the conversation id when we have one so follow-ups resolve
        // referents ("what about the total?"); omit it to start a new one.
        chatQueryInDTO: { message, endUserId, ...(sessionId ? { sessionId } : {}) },
      });
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
        let result: ChatQueryOutDTO;
        const hadSession = sessionIdRef.current !== undefined;
        try {
          result = await queryWithRetry(text);
        } catch (error) {
          // A turn that CARRIED a session and 404s means the conversation is
          // gone (24h idle TTL, an explicit reset, or end-user scope drift).
          // Drop the stale id and retry once as a fresh conversation, so the
          // expiry is transparent — the user just gets an answer, no memory.
          if (hadSession && httpStatus(error) === 404) {
            sessionIdRef.current = undefined;
            result = await queryWithRetry(text);
          } else {
            throw error;
          }
        }
        if (!mountedRef.current) {
          return;
        }
        // The response always returns the (possibly newly created) conversation
        // id — store it so the next turn continues this thread.
        sessionIdRef.current = result.sessionId ?? sessionIdRef.current;
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
        // Reading the error body is async (fetch), so re-check mount after.
        const info = await readChatError(error);
        if (!mountedRef.current) {
          return;
        }
        appendMessage(describeChatError(info, text));
      } finally {
        if (mountedRef.current) {
          setBusy(false);
        }
      }
    },
    [queryWithRetry, appendMessage],
  );

  /**
   * Reset to a brand-new conversation: clear the transcript and forget the
   * session id so the next message starts fresh. The old session is deleted
   * server-side best-effort — the local reset is authoritative, and a failed
   * delete just leaves the session to lapse on its idle TTL.
   */
  const startNewChat = useCallback(() => {
    if (busy) {
      return;
    }
    const staleSession = sessionIdRef.current;
    sessionIdRef.current = undefined;
    setMessages([]);
    setDraft('');
    if (staleSession !== undefined) {
      void (async () => {
        try {
          const token = await tokenManager.getToken();
          await GeminaClient.withSessionToken(token, baseUrl).chat.deleteChatSession({
            sessionId: staleSession,
          });
        } catch {
          // Unreachable/expired session: nothing to clean up client-side.
        }
      })();
    }
  }, [busy, tokenManager, baseUrl]);

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
      {messages.length > 0 && (
        <div className="gemina-chat__header">
          <button
            type="button"
            className="gemina-chat__newchat"
            onClick={startNewChat}
            disabled={busy}
          >
            New chat
          </button>
        </div>
      )}
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
