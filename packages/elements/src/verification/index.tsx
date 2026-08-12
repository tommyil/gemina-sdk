/**
 * <GeminaVerification> — drop-in human verification UI for one extraction.
 *
 * Auth flows exclusively through a {@link GeminaTokenManager} (chat parity):
 * the component asks it for a short-lived session token and calls
 * `GET /v1/documents/extractions/{id}` through `@gemina/sdk`. It never sees —
 * and cannot accept — a Gemina API key.
 *
 * This module owns the fetch + state machine + edge states (Task 14):
 * loading → unavailable | review. The later phases (confirming, submitting,
 * submit-error, done) are declared in the phase union now and wired by the
 * submit flow (Task 17); editing state arrives in Task 16 and the flash/RTL
 * layer in Task 15.
 *
 * SSR-safe: no `window`/`document` access at import time; styles are
 * injected on mount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { GeminaClient } from '@gemina/sdk';
import type { ExtractionPrimaryViewOutDTO } from '@gemina/sdk';
import { httpStatus, readErrorEnvelope } from '../internal/response-like';
import { buildBindings, indexBindingsByFieldPointer } from './bindings';
import { classifyData, ROW_META_KEY } from './classify';
import { VerificationForm } from './form';
import { ensureVerificationStylesInjected } from './styles';
import type {
  GeminaVerificationProps,
  VerificationErrorDetail,
  VerificationErrorReason,
} from './types';
import { VerificationViewer } from './viewer';

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

/** Stable empty edits map for the pre-Task-16 form (SectionShared contract:
 * `edits` is compared by reference, so this must never be re-created). */
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
  const { extractionId, tokenManager, baseUrl, theme = 'auto', onError, className } = props;

  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [loaded, setLoaded] = useState<LoadedData | null>(null);
  // Held separately from `loaded`: Task 15 refreshes an expired URL in place
  // without disturbing the (memo-feeding) values/schema snapshot.
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const mountedRef = useRef(false);
  // Monotonic load id: a load that lost the race (prop change re-ran the
  // effect, or Retry started a newer attempt) must not write its result.
  const loadSeqRef = useRef(0);
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

  // Stable placeholders (SectionShared contract: handlers are compared by
  // reference in the row memo). Task 16 wires editing; Task 15 wires flash.
  const handleEdit = useCallback((_rawKey: string, _value: string) => {}, []);
  const handleFlash = useCallback((_rects: Array<{ points: [number, number][] }>) => {}, []);

  const handleRetry = useCallback(() => {
    void load();
  }, [load]);

  const rootClassName = [
    'gemina-verification',
    `gemina-verification--${theme}`,
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
            {imageUrl !== null && <VerificationViewer src={imageUrl} />}
            <VerificationForm
              classified={classified}
              unmatched={unmatched}
              bindingIndex={bindingIndex}
              edits={NO_EDITS}
              onEdit={handleEdit}
              readOnly={phase.readOnly}
              onFlash={handleFlash}
            />
          </div>
        </>
      );
      break;
    default:
      // confirming / submitting / submit-error / done — unreachable until the
      // submit flow (Task 17) starts entering them.
      content = null;
  }

  return <div className={rootClassName}>{content}</div>;
}
