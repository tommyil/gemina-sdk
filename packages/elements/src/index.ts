// Token management (no React required — also available as
// `@gemina/elements/token-manager`).
export { GeminaTokenManager } from './token-manager';
export type { FetchTokenResult, GeminaTokenManagerOptions } from './token-manager';

// Chat UI (React — also available as `@gemina/elements/chat`).
export { GeminaChat } from './chat';
export type { GeminaChatProps, GeminaChatTheme, GeminaChatDirection } from './chat';

// Verification UI (React — also available as `@gemina/elements/verification`).
export { GeminaVerification } from './verification/index';
export type {
  GeminaVerificationProps,
  GeminaVerificationTheme,
  GeminaVerificationDirection,
  VerificationErrorReason,
  VerificationErrorDetail,
  VerificationCompletion,
} from './verification/index';

export { VERSION } from './version';
