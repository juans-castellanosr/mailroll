export { type EmailAddress, normalizeEmail, parseEmailAddress } from './domain/addressing/email-address';
export type { Recipient } from './domain/addressing/recipient';
export { EMAIL_FIELD, type SourceRecord } from './domain/addressing/source-record';
export {
  INTEGRATION_KIND,
  type IntegrationConfiguration,
  type IntegrationDescriptor,
  type IntegrationRoles,
  type SecretDeclaration,
} from './contracts/integration-descriptor';
export {
  type AcceptedOutcome,
  type FailureScope,
  type NotAcceptedOutcome,
  type NotAcceptedReason,
  type PreparedSender,
  type RecipientAcceptance,
  SENDER_CONTRACT,
  type SendAttempt,
  type SendOutcome,
  type SendPreferences,
  type SenderCapabilities,
  type SenderContext,
  type SenderInteraction,
  type SenderRole,
  type SentCopy,
  type UnknownOutcome,
} from './contracts/sender';
export {
  ensureUniqueIntegrationIds,
  validateIntegrationDescriptor,
  type ValidatedConfiguration,
  type ValidatedIntegration,
  type ValidatedPreparedSender,
  type ValidatedSenderRole,
} from './contracts/validate-descriptor';
export {
  type SendExpectation,
  settleSend,
  type ValidatedAcceptedOutcome,
  type ValidatedNotAcceptedOutcome,
  type ValidatedSendOutcome,
  type ValidatedUnknownOutcome,
  validateSendOutcome,
} from './contracts/validate-send-outcome';
export type { Campaign } from './domain/catalog/campaign';
export type { Connection, ProviderKind } from './domain/catalog/connection';
export { DEFAULT_PACING, type Pacing } from './domain/catalog/pacing';
export type { CcPolicy, ResolvedTemplate, Template } from './domain/catalog/template';
export {
  AuthError,
  ConfigError,
  DataSourceError,
  MailrollError,
  type FailureCategory,
  RunCancelledError,
  SendCancelledError,
  SendError,
  type SendErrorCategory,
  SignInRequiredError,
  StatePersistenceError,
  TemplateRenderError,
} from './domain/kernel/errors';
export { requiredField } from './domain/kernel/required-field';
export { invalid, valid, type ValidationOutcome } from './domain/kernel/validation-outcome';
export type { InlineAttachment } from './domain/messaging/inline-attachment';
export type { Message } from './domain/messaging/message';
export type { RenderedEmail } from './domain/messaging/rendered-email';
export type { RunMode } from './domain/run/run-mode';
export type { SendResult, SkipCode, SkippedResult } from './domain/run/send-result';
export type { ResendPolicy, SendSelection, TemplateTarget } from './domain/run/send-selection';
export { foldJournal } from './domain/run/fold-journal';
export {
  type CcObservation,
  emptyState,
  INTERRUPTED_MESSAGE,
  type RecipientJournalEntry,
  type RecipientStatus,
  type ResendFailure,
  settleStatus,
  type TemplateState,
} from './domain/run/template-state';
export { MemoryStateStore } from './adapters/memory-state-store';
export { collectRecipients, type CollectedRecipients, type ValidRecipient } from './engine/collect-recipients';
export { definePlugin } from './engine/define-plugin';
export { type Assignment, distribute } from './engine/distribute';
export { planRun, type PlanRunArgs, type RunPlan } from './engine/plan-run';
export { needsAttention, report, type RunReport } from './engine/report';
export { RetryingEmailProvider } from './engine/retrying-email-provider';
export { type PreparedConnectionSender, runTemplate, type RunTemplateDeps } from './engine/run-engine';
export { TemplateRunError } from './engine/template-run-error';
export type { PreparedTemplate, RecipientListing, TemplatePlugin, TemplatePluginDeps } from './engine/template-plugin';
export type { AuthProvider } from './ports/auth-provider';
export type { DataSource } from './ports/data-source';
export type { EmailProvider, SendOptions } from './ports/email-provider';
export type { EmailProviderFactory, EmailProviderOptions } from './ports/email-provider-factory';
export type { LogFields, Logger, LogValue } from './ports/logger';
export type { RecipientValidator } from './ports/recipient-validator';
export type { Sleeper } from './ports/sleeper';
export type { StateLock, StateStore } from './ports/state-store';
export type { TemplateRenderer } from './ports/template-renderer';
export { assertMarkersPresent, type MarkerRenderInput, renderWithMarkers } from './rendering/marker-renderer';
export { escapeHtml, substitute } from './rendering/substitute';
