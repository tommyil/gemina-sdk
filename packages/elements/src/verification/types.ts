import type { ComparisonSummaryModel } from '@gemina/sdk';

/** Visual theme. `"auto"` follows `prefers-color-scheme`. */
export type GeminaVerificationTheme = 'light' | 'dark' | 'auto';

/**
 * Text direction. `"auto"` flips to RTL when the extraction's field values
 * contain Hebrew (U+0590–U+05FF), mirroring the chat widget's autodetect.
 */
export type GeminaVerificationDirection = 'ltr' | 'rtl' | 'auto';

/** Stable reasons handed to onError. Matched from HTTP status + meta, never from error text. */
export type VerificationErrorReason =
  | 'purged'                    // meta.purgedAt set — retention policy
  | 'not-available'             // 404: nonexistent OR out of token scope (no existence leak)
  | 'not-completed'             // processingStatus !== 'success'
  | 'verification-unavailable'  // SUCCESS but validationFeedback is null/empty (backend delta not live)
  | 'session-expired'           // 401 after the one mandated retry
  | 'load-failed'               // network/5xx on the initial GET
  | 'submit-failed';            // network/5xx on PUT (edits preserved, inline retry offered)

export interface VerificationErrorDetail {
  status?: number;
  errorCode?: string;
  description?: string;
}

export interface VerificationCompletion {
  /**
   * Every submitted entry keyed by its human label (e.g. `supplier_name`,
   * `line_0_description`) — the raw `label:...|ptr:...` key format never
   * reaches the host app.
   */
  correctedValues: Record<string, unknown>;
  /** Gemina's scoring response for the submission. */
  summary: ComparisonSummaryModel;
}

export interface GeminaVerificationProps {
  /** The extraction to verify. Must be inside the session token's scope. */
  extractionId: string;
  /** Token source. Required — see GeminaTokenManager. */
  tokenManager: import('../token-manager').GeminaTokenManager;
  /** Gemina API base URL (default `https://api.gemina.co`). */
  baseUrl?: string;
  /** Visual theme (default `"auto"`). */
  theme?: GeminaVerificationTheme;
  /** Text direction (default `"auto"`). */
  dir?: GeminaVerificationDirection;
  /** Called exactly once, after a successful feedback submission. */
  onComplete?: (result: VerificationCompletion) => void;
  /** Called when the component lands in a terminal error/edge state. */
  onError?: (reason: VerificationErrorReason, detail?: VerificationErrorDetail) => void;
  /** Extra class name(s) for the root element (e.g. to override CSS vars). */
  className?: string;
}
