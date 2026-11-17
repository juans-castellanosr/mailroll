import { MailrollError } from '../domain/kernel/errors';
import type { RunReport } from './report';

export class TemplateRunError extends MailrollError {
  constructor(
    message: string,
    readonly report: RunReport,
    options: { readonly cause: unknown },
  ) {
    super(message, options);
  }
}
