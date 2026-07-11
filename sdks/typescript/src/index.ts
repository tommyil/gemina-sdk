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
export { GeminaError, GeminaProcessingError, GeminaTimeoutError } from './errors';
export { VERSION } from './version';
