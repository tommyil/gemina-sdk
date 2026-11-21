// Full generated client surface (APIs, models, runtime).
export * from './generated';

// Hand-written convenience layer.
export { GeminaClient, GeminaChatConversation, DEFAULT_BASE_URL } from './helpers';
export type {
  ConversationOptions,
  DocumentSource,
  GeminaClientApis,
  GeminaClientOptions,
  ProcessDocumentOptions,
} from './helpers';
export {
  GeminaError,
  GeminaProcessingError,
  GeminaTimeoutError,
  GeminaWebhookVerificationError,
} from './errors';
export type { GeminaWebhookVerificationReason } from './errors';
export { unwrapWebhook, isExtractionCompleted, isWebhookTest } from './webhooks';
export type {
  ExtractionCompletedWebhookEvent,
  UnwrapWebhookOptions,
  WebhookEvent,
  WebhookHeaders,
  WebhookTestWebhookEvent,
} from './webhooks';
export { VERSION } from './version';
