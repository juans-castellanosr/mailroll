import type { EmailAddress } from '../domain/addressing/email-address';
import type { Template } from '../domain/catalog/template';
import type { SkippedResult } from '../domain/run/send-result';
import type { RunReport } from './report';
import type { RunTemplateDeps } from './run-engine';
import type { DataSource } from '../ports/data-source';

export type TemplatePluginDeps = Omit<RunTemplateDeps<never>, 'validator' | 'renderer'>;

export interface RecipientListing {
  readonly accepted: readonly EmailAddress[];
  readonly rejected: readonly SkippedResult[];
}

export interface PreparedTemplate {
  readonly listRecipients: (source: DataSource) => Promise<RecipientListing>;
  readonly run: (deps: TemplatePluginDeps) => Promise<RunReport>;
}

export interface TemplatePlugin {
  readonly prepare: (template: Template) => Promise<PreparedTemplate>;
}
