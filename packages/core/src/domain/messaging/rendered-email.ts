import type { InlineAttachment } from './inline-attachment';

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly inlineAttachments?: readonly InlineAttachment[];
}
