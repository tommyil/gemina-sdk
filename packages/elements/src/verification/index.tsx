/**
 * <GeminaVerification> — drop-in human verification UI for one extraction.
 *
 * Auth flows exclusively through a {@link GeminaTokenManager} (chat parity):
 * the component asks it for a short-lived session token and calls
 * `GET /v1/documents/extractions/{id}` through `@gemina/sdk`. It never sees —
 * and cannot accept — a Gemina API key.
 *
 * This module owns the fetch + state machine + edge states (Task 14):
 * loading → unavailable | review — the layout/flash/RTL layer (Task 15):
 * the stacked-below-860px root observer, eye-click → viewer flash wiring,
 * chat-parity Hebrew direction autodetect, and the silent expired-image-URL
 * refresh — and the edit state + progress footer (Task 16): the immutable
 * edits map with delete-on-revert dirty tracking, and the
 * "N confirmed · M corrected" line fed by composeSubmission. The later phases
 * (confirming, submitting, submit-error, done) are declared in the phase
 * union now and wired by the submit flow (Task 17).
 *
 * SSR-safe: no `window`/`document` access at import time; styles are
 * injected on mount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { GeminaClient } from '@gemina/sdk';
import type { ExtractionPrimaryViewOutDTO } from '@gemina/sdk';
import { httpStatus, readErrorEnvelope } from '../internal/response-like';
import {
  buildBindings,
  composeSubmission,
  indexBindingsByFieldPointer,
  toInputString,
} from './bindings';
import type { FieldBinding } from './bindings';
import { classifyData, ROW_META_KEY } from './classify';
import { VerificationForm } from './form';
import { ensureVerificationStylesInjected } from './styles';
import type {
  GeminaVerificationProps,
  VerificationErrorDetail,
  VerificationErrorReason,
} from './types';
import { VerificationViewer } from './viewer';
import type { RelativeRect } from './viewer';

export type {
  GeminaVerificationProps,
  GeminaVerificationTheme,
  GeminaVerificationDirection,
  VerificationErrorReason,
  VerificationErrorDetail,
  VerificationCompletion,
} from './types';

/**
 * The component's complete phase model. Task 14 implements
 * loading/unavailable/review; `confirming`, `submitting`, `submit-error`,
 * and `done` are entered only by the submit flow (Task 17).
 */
type Phase =
  | { name: 'loading' }
  | { name: 'unavailable'; reason: VerificationErrorReason; message: string; canRetry: boolean }
  | { name: 'review'; readOnly: boolean; alreadyValidated: boolean }
  | { name: 'confirming' } // confirm dialog open over review (Task 17)
  | { name: 'submitting' } // Task 17
  | { name: 'submit-error'; message: string } // Task 17
  | { name: 'done'; confirmed: number; corrected: number }; // Task 17

/** Hebrew Unicode block (U+0590–U+05FF) — chat.tsx's exact detector. */
const HEBREW_RE = /[\u0590-\u05FF]/;

/** Below this root width the two panes stack (one column, sticky viewer). */
const STACKED_BREAKPOINT = 860; // px

/** At most one silent image-URL refresh per window — the refetch-loop brake. */
const IMAGE_REFRESH_THROTTLE_MS = 60_000;

const LOADING_TEXT = 'Loading extraction…';
const SESSION_EXPIRED_TEXT = 'Session expired — please reload the page or sign in again.';
const NOT_AVAILABLE_TEXT = 'This extraction is not available.';
const LOAD_FAILED_TEXT = "Couldn't load the extraction.";
const PURGED_TEXT = 'Document no longer available (retention policy).';
const NOT_COMPLETED_TEXT = 'This extraction did not complete, so there is nothing to verify.';
const VERIFICATION_UNAVAILABLE_TEXT = "Verification isn't available for this extraction.";
// Deliberately does NOT imply the shown data is the corrected data — the
// primary view returns the ORIGINAL extraction, not the validated values.
const ALREADY_VALIDATED_TEXT = 'Already verified — showing the original extraction.';

/** What a successful load pins for the review phase (values + schema together,
 * so the derived memos see one consistent snapshot). */
interface LoadedData {
  values: unknown;
  schema: string[];
}

/** The empty edits map — the initial state AND every load's reset value.
 * One shared instance (SectionShared contract: `edits` is compared by
 * reference, so "no edits" must always be the same object). */
const NO_EDITS: ReadonlyMap<string, string> = new Map();

/**
 * Embeddable Gemina extraction-verification UI.
 *
 * ```tsx
 * <GeminaVerification
 *   extractionId={extractionId}
 *   tokenManager={tokenManager}
 *   onComplete={(result) => console.log(result.summary)}
 * />
 * ```
 */
export function GeminaVerification(props: GeminaVerificationProps): React.JSX.Element {
  const {
    extractionId,
    tokenManager,
    baseUrl,
    theme = 'auto',
    dir = 'auto',
    onError,
    className,
  } = props;

  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [loaded, setLoaded] = useState<LoadedData | null>(null);
  // Dirty fields only: raw schema key → current input string, VERBATIM (no
  // trim/normalize — that is the composer's job at submit). Replaced
  // immutably on every change; delete-on-revert keeps composeSubmission's
  // confirmed/corrected counts honest (see its edits-map contract).
  const [edits, setEdits] = useState<ReadonlyMap<string, string>>(NO_EDITS);
  // Held separately from `loaded`: the expiry refresh swaps an expired URL in
  // place without disturbing the (memo-feeding) values/schema snapshot.
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  // The rects currently flashing on the viewer (null = no flash in flight).
  const [flashRects, setFlashRects] = useState<RelativeRect[] | null>(null);
  // One-column layout, driven by the ROOT's own width (see the observer below).
  const [stacked, setStacked] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);
  // Monotonic load id: a load that lost the race (prop change re-ran the
  // effect, or Retry started a newer attempt) must not write its result.
  const loadSeqRef = useRef(0);
  // Timestamp of the last expiry-triggered refetch (the 60s throttle).
  const lastImageRefreshRef = useRef(0);
  // Latest onError without threading its identity through the load callback.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  /**
   * Enter a terminal unavailable state and notify the host. onError fires
   * once per terminal-state ENTRY (see the prop's JSDoc): each resolved load
   * attempt calls this at most once, and a Retry that fails again re-enters —
   * and therefore re-fires.
   */
  const enterUnavailable = useCallback(
    (
      reason: VerificationErrorReason,
      message: string,
      canRetry: boolean,
      detail?: VerificationErrorDetail,
    ) => {
      setPhase({ name: 'unavailable', reason, message, canRetry });
      onErrorRef.current?.(reason, detail);
    },
    [],
  );

  const fetchOnce = useCallback(async () => {
    const token = await tokenManager.getToken();
    return GeminaClient.withSessionToken(token, baseUrl).documents.getDocumentExtraction({
      documentExtractionId: extractionId,
    });
  }, [tokenManager, baseUrl, extractionId]);

  /** The chat widget's mandated 401 pattern: invalidate + retry exactly once. */
  const fetchWithRetry = useCallback(async () => {
    try {
      return await fetchOnce();
    } catch (error) {
      if (httpStatus(error) !== 401) {
        throw error;
      }
      tokenManager.invalidate();
      return await fetchOnce();
    }
  }, [fetchOnce, tokenManager]);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    /** Guard on EVERY async setState: unmount AND stale-load protection. */
    const live = () => mountedRef.current && loadSeqRef.current === seq;

    setPhase({ name: 'loading' });
    // A stale flash must not survive into the next review: the viewer
    // unmounts during loading, and a REMOUNTED viewer handed old non-null
    // flashRects would phantom-flash the new document once it sizes up.
    setFlashRects(null);
    // A new load must not inherit the previous extraction's expiry-refresh
    // throttle window (the viewer is unmounted until review re-enters, so
    // nothing can race this reset).
    lastImageRefreshRef.current = 0;
    let view: ExtractionPrimaryViewOutDTO;
    try {
      view = await fetchWithRetry();
    } catch (error) {
      // Reading the error body is async (fetch), so re-check liveness after.
      const detail = await readErrorEnvelope(error);
      if (!live()) {
        return;
      }
      if (detail.status === 401) {
        // Only reachable after the invalidate-retry-once path failed again.
        enterUnavailable('session-expired', SESSION_EXPIRED_TEXT, false, detail);
      } else if (detail.status === 404) {
        enterUnavailable('not-available', NOT_AVAILABLE_TEXT, false, detail);
      } else {
        // Everything else — 5xx, network failures, and a tokenManager whose
        // fetchToken rejected (no HTTP status at all) — is retryable: the
        // server or the tenant's token backend may recover.
        enterUnavailable('load-failed', LOAD_FAILED_TEXT, true, detail);
      }
      return;
    }
    if (!live()) {
      return;
    }

    const enterReview = (alreadyValidated: boolean) => {
      const schema = view.meta.validationFeedback?.validationSchema;
      setLoaded({
        values: view.values,
        schema: Array.isArray(schema) ? schema : [],
      });
      // Fresh extraction data → clean editing slate, batched with setLoaded so
      // new bindings never pair with old edits for even one commit. Covers the
      // extractionId change, Retry, AND the Task-17 409-refetch (all of which
      // route through load()).
      setEdits(NO_EDITS);
      const url = view.document.imageUrl;
      setImageUrl(typeof url === 'string' && url.length > 0 ? url : null);
      setPhase({ name: 'review', readOnly: alreadyValidated, alreadyValidated });
    };

    // Result mapping — EXACT order: purge before status, validated before
    // schema (an already-validated extraction with a null schema must land in
    // review-readOnly, not verification-unavailable).
    if (view.meta.purgedAt != null) {
      enterUnavailable('purged', PURGED_TEXT, false);
    } else if (view.meta.processingStatus !== 'success') {
      enterUnavailable('not-completed', NOT_COMPLETED_TEXT, false);
    } else if (view.meta.validated === true) {
      enterReview(true);
    } else if (
      !Array.isArray(view.meta.validationFeedback?.validationSchema) ||
      view.meta.validationFeedback.validationSchema.length === 0
    ) {
      enterUnavailable('verification-unavailable', VERIFICATION_UNAVAILABLE_TEXT, false);
    } else {
      enterReview(false);
    }
  }, [fetchWithRetry, enterUnavailable]);

  useEffect(() => {
    mountedRef.current = true;
    ensureVerificationStylesInjected();
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  // Stacked layout: the ROOT observes its OWN width — not the window, because
  // the host may embed the widget in a narrow column of a wide page — and
  // flips to one column below the breakpoint. useEffect (not layout effect)
  // keeps server rendering warning-free; the first client frame corrects.
  // SSR/test-safe: no ResizeObserver → a one-shot measure; a width of 0
  // (unmeasured or hidden host) never forces a layout flip.
  useEffect(() => {
    const el = rootRef.current;
    if (el === null) {
      return;
    }
    const apply = (width: number) => setStacked(width > 0 && width < STACKED_BREAKPOINT);
    if (typeof ResizeObserver === 'undefined') {
      apply(el.getBoundingClientRect().width);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) {
        apply(rect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // --- Derived review data — computed ONCE per load (form stability contract:
  // `classified`/`bindingIndex` are compared by reference in the row memo). ---
  // classifyData is total (null/garbage values → empty buckets) — no guard.
  const classified = useMemo(() => classifyData(loaded?.values), [loaded]);
  const bindings = useMemo(() => buildBindings(loaded?.schema ?? [], loaded?.values), [loaded]);
  const bindingIndex = useMemo(() => indexBindingsByFieldPointer(bindings), [bindings]);
  // Bindings whose fieldPointer matches no classified leaf — the "model
  // missed the whole field" case, rendered as the form's Not-detected section.
  const unmatched = useMemo(() => {
    const rendered = new Set<string>();
    for (const field of classified.headers) {
      rendered.add(field.pointer);
    }
    for (const list of classified.simpleLists) {
      for (const item of list.items) {
        rendered.add(item.pointer);
      }
    }
    for (const entity of classified.entities) {
      for (const item of entity.items) {
        for (const cell of Object.values(item)) {
          rendered.add(cell.pointer);
        }
      }
    }
    for (const table of classified.tables) {
      for (const row of table.rows) {
        for (const [key, cell] of Object.entries(row)) {
          // _rowMeta is synthetic (its pointer is the ROW pointer) — it never
          // corresponds to a binding, so it must not mask one.
          if (key !== ROW_META_KEY) {
            rendered.add(cell.pointer);
          }
        }
      }
    }
    return bindings.filter((binding) => !rendered.has(binding.fieldPointer));
  }, [classified, bindings]);
  // Every detection region the extraction carries, feeding the viewer's
  // overlay toggle. Memoized on the classified snapshot (stability contract):
  // the viewer sees ONE stable array per load. undefined when there is
  // genuinely nothing to overlay — the viewer's hasRects check treats
  // undefined and empty alike (toggle disabled); undefined states the intent.
  const overlayRects = useMemo(() => {
    const rects: RelativeRect[] = [];
    for (const field of classified.headers) {
      if (field.coordinates) {
        rects.push(field.coordinates);
      }
    }
    for (const list of classified.simpleLists) {
      for (const item of list.items) {
        if (item.coordinates) {
          rects.push(item.coordinates);
        }
      }
    }
    for (const entity of classified.entities) {
      for (const item of entity.items) {
        for (const cell of Object.values(item)) {
          if (cell.coordinates) {
            rects.push(cell.coordinates);
          }
        }
      }
    }
    for (const table of classified.tables) {
      for (const row of table.rows) {
        for (const [key, cell] of Object.entries(row)) {
          // _rowMeta is synthetic (coordinates null by construction) — skip
          // it so a future row-level coordinate never renders a stray box.
          if (key !== ROW_META_KEY && cell.coordinates) {
            rects.push(cell.coordinates);
          }
        }
      }
    }
    return rects.length > 0 ? rects : undefined;
  }, [classified]);

  // dir="auto" (chat parity): Hebrew anywhere in the bound DISPLAY values —
  // toInputString over binding.extracted, the same strings the inputs prefill,
  // never the raw JSON payload — flips the whole widget to RTL. Computed once
  // per load: `bindings` is memoized on the loaded snapshot.
  const hasHebrewContent = useMemo(
    () => bindings.some((binding) => HEBREW_RE.test(toInputString(binding.extracted))),
    [bindings],
  );
  const effectiveDir: 'ltr' | 'rtl' = dir === 'auto' ? (hasHebrewContent ? 'rtl' : 'ltr') : dir;

  // Revert detection needs the binding behind a raw key. Read through a ref
  // so handleEdit stays permanently stable (SectionShared contract: the
  // table-row memo compares onEdit by reference; a per-load identity would
  // silently re-render every row once per load).
  const bindingsByRawKey = useMemo(() => {
    const map = new Map<string, FieldBinding>();
    for (const binding of bindings) {
      map.set(binding.key.raw, binding);
    }
    return map;
  }, [bindings]);
  const bindingsByRawKeyRef = useRef(bindingsByRawKey);
  bindingsByRawKeyRef.current = bindingsByRawKey;

  // The edit tracker. The value is stored VERBATIM — never trimmed or
  // normalized (IME safety: the input must echo exactly what the user is
  // composing; composeSubmission trims at submit time). Dirty-tracking
  // contract (Task 4): the entry is DELETED when the value returns to the
  // binding's initial input string, so composeSubmission's counts stay honest.
  // Every change builds a NEW Map (SectionShared: the row-memo comparator
  // short-circuits on reference equality, so in-place mutation renders nothing);
  // no-op updates return `prev` unchanged to keep that same short-circuit.
  const handleEdit = useCallback((rawKey: string, value: string) => {
    const binding = bindingsByRawKeyRef.current.get(rawKey);
    // Pristine = the input shows exactly what an untouched input would show:
    // toInputString of the binding's DISPLAY value (FieldInput's prefill) —
    // including '' for a never-extracted fill-in.
    const pristine = binding !== undefined && value === toInputString(binding.extracted);
    setEdits((prev) => {
      if (pristine) {
        if (!prev.has(rawKey)) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(rawKey);
        return next;
      }
      if (prev.get(rawKey) === value) {
        return prev;
      }
      const next = new Map(prev);
      next.set(rawKey, value);
      return next;
    });
  }, []);

  // Progress counts — composeSubmission IS the source of truth (the same call
  // Task 17 submits), so the line can never disagree with what would be sent.
  const submission = useMemo(() => composeSubmission(bindings, edits), [bindings, edits]);

  // Flash wiring (form → viewer). STABLE callback — the table-row memo
  // compares onFlash by reference, so rows never re-render on unrelated
  // flashes — that stores a FRESH array per eye-click: TableRow memoizes its
  // row rects, so without the copy a second click on the same row would hand
  // the viewer's flash effect an identical reference and never restart.
  const handleFlash = useCallback((rects: Array<{ points: [number, number][] }>) => {
    setFlashRects(rects.map((rect) => ({ points: rect.points })));
  }, []);

  // The viewer announces the fade finished: drop our reference so the next
  // click is a fresh transition. NEVER gate anything beyond this cleanup on
  // onFlashComplete — it may never fire (the image may never load).
  const handleFlashComplete = useCallback(() => {
    setFlashRects(null);
  }, []);

  /**
   * Silent expired-image-URL refresh. Swaps ONLY `imageUrl` — deliberately
   * NOT `loaded` (values/meta): replacing the loaded snapshot would re-create
   * the memoized classified/bindings objects and shift the dirty-tracking
   * baseline mid-edit, yanking the form out from under the reviewer. (The
   * plan's "and refreshed values/meta" parenthetical is superseded by review.)
   * Throttled to one refetch per 60s so a signed URL that keeps dying (e.g. a
   * document purged mid-review) cannot refetch-loop; the viewer's own
   * has-loaded gate already stops the loop for URLs that never load at all.
   *
   * INVARIANT: any future refetch that writes state must bump loadSeqRef or
   * route through load() — a refetch that writes without owning the sequence
   * can be overtaken by a newer load and clobber its state.
   */
  const handleImageExpired = useCallback(() => {
    const now = Date.now();
    if (now - lastImageRefreshRef.current < IMAGE_REFRESH_THROTTLE_MS) {
      return;
    }
    lastImageRefreshRef.current = now;
    const seq = loadSeqRef.current;
    fetchWithRetry()
      .then((view) => {
        // A newer load owns the state now (or we unmounted) — drop it.
        if (!mountedRef.current || loadSeqRef.current !== seq) {
          return;
        }
        const url = view.document.imageUrl;
        if (typeof url === 'string' && url.length > 0) {
          setImageUrl(url);
        }
      })
      // Swallowed by design: the refresh is best-effort background work — the
      // review (and any pending edits) must stay put on failure. The reviewer
      // keeps a broken image until the next throttle window; phase/loaded/
      // edits are never touched from here.
      .catch(() => {});
  }, [fetchWithRetry]);

  const handleRetry = useCallback(() => {
    void load();
  }, [load]);

  const rootClassName = [
    'gemina-verification',
    `gemina-verification--${theme}`,
    effectiveDir === 'rtl' ? 'gemina-verification--rtl' : '',
    stacked ? 'gemina-verification--stacked' : '',
    className ?? '',
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  let content: React.JSX.Element | null;
  switch (phase.name) {
    case 'loading':
      content = (
        <div className="gemina-verification__state" role="status">
          {LOADING_TEXT}
        </div>
      );
      break;
    case 'unavailable':
      content = (
        <div className="gemina-verification__state" role="alert">
          <div>{phase.message}</div>
          {phase.canRetry && (
            <button type="button" className="gemina-verification__retry" onClick={handleRetry}>
              Retry
            </button>
          )}
        </div>
      );
      break;
    case 'review':
      content = (
        <>
          {phase.alreadyValidated && (
            <div className="gemina-verification__banner">{ALREADY_VALIDATED_TEXT}</div>
          )}
          <div className="gemina-verification__panes">
            {imageUrl !== null && (
              <VerificationViewer
                src={imageUrl}
                relativeRects={overlayRects}
                flashRects={flashRects}
                onFlashComplete={handleFlashComplete}
                onImageExpired={handleImageExpired}
              />
            )}
            <VerificationForm
              classified={classified}
              unmatched={unmatched}
              bindingIndex={bindingIndex}
              edits={edits}
              onEdit={handleEdit}
              readOnly={phase.readOnly}
              onFlash={handleFlash}
            />
          </div>
          <div className="gemina-verification__footer">
            {/* aria-live: a reviewer deep in a long form hears the count move
                as they confirm/correct without tabbing back to the footer. */}
            <div className="gemina-verification__progress" aria-live="polite">
              {`${submission.confirmed} confirmed · ${submission.corrected} corrected`}
            </div>
            {/* TODO(Task 17): onClick → phase 'confirming' (the confirm
                dialog). Inert until then — entering the phase today would
                blank the review (the switch renders null for it), so the
                click stays ungated-off rather than half-wired. */}
            <button
              type="button"
              className="gemina-verification__submit"
              disabled={phase.readOnly}
            >
              Submit feedback
            </button>
          </div>
        </>
      );
      break;
    default:
      // confirming / submitting / submit-error / done — unreachable until the
      // submit flow (Task 17) starts entering them.
      content = null;
  }

  return (
    <div ref={rootRef} className={rootClassName} dir={effectiveDir}>
      {content}
    </div>
  );
}
