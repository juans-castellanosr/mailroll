import type { SourceRecord } from '../domain/addressing/source-record';
import type { ValidationOutcome } from '../domain/kernel/validation-outcome';

export interface RecipientValidator<T> {
  validate(record: SourceRecord): ValidationOutcome<T>;
}
