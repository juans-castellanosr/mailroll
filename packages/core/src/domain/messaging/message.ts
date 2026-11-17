import type { EmailAddress } from '../addressing/email-address';
import type { InlineAttachment } from './inline-attachment';

export interface Message {
  readonly to: EmailAddress;
  readonly subject: string;
  readonly html: string;
  readonly cc?: readonly EmailAddress[];
  readonly replyTo?: EmailAddress;
  readonly inlineAttachments?: readonly InlineAttachment[];
}
