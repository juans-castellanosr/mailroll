export * from '@mailroll/core';

export { CsvDataSource, type CsvDataSourceOptions } from '../integrations/datasources/csv/csv-data-source';
export { NullEmailProvider } from '../integrations/providers/preview/null-email-provider';
export { PreviewEmailProvider } from '../integrations/providers/preview/preview-email-provider';
export { loadCompiledTemplate } from '../integrations/renderers/mjml/load-compiled-template';
export { buildSelection, type RawSelection } from '../platform/composition/build-selection';
export {
  type ListRef,
  RunInterruptedError,
  runSelection,
  type RunSelectionOptions,
  type TemplateRunResult,
} from '../platform/composition/build-runner';
export {
  connectionStateLocation,
  type ConnectionStateLocation,
  type ConnectionStateLocationOptions,
} from '../platform/config/connection-state-location';
export { connectionEnvKey } from '../platform/config/resolve-connection-secrets';
export { discoverCampaigns } from '../platform/discovery/discover-campaigns';
export { ConsoleLogger, type ConsoleLoggerOptions, type LogLevel } from '../platform/logging/console-logger';
export { FileStateStore } from '../platform/state/file-state-store';
export {
  type CampaignReport,
  type CampaignStatusOptions,
  getCampaignStatus,
  type ListReport,
  type TemplateReport,
} from '../platform/status/campaign-status';
export type { ListCounts } from '../platform/status/list-status';
