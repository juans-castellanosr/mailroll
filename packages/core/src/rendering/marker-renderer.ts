import { TemplateRenderError } from '../domain/kernel/errors';
import type { InlineAttachment } from '../domain/messaging/inline-attachment';
import type { RenderedEmail } from '../domain/messaging/rendered-email';
import { substitute } from './substitute';

export interface MarkerRenderInput {
  readonly template: string;
  readonly subject: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly rawMarkers?: Readonly<Record<string, string>>;
  readonly inlineAttachments?: readonly InlineAttachment[];
}

export function renderWithMarkers(input: MarkerRenderInput): RenderedEmail {
  let html = substitute(input.template, input.variables);

  if (input.rawMarkers !== undefined) {
    for (const [marker, replacement] of Object.entries(input.rawMarkers)) {
      html = html.replaceAll(marker, () => replacement);
    }
  }

  if (input.inlineAttachments !== undefined && input.inlineAttachments.length > 0) {
    return { subject: input.subject, html, inlineAttachments: input.inlineAttachments };
  }

  return { subject: input.subject, html };
}

export function assertMarkersPresent(compiled: string, markers: readonly string[]): void {
  for (const marker of markers) {
    if (!compiled.includes(marker)) {
      throw new TemplateRenderError(`compiled template is missing the marker "${marker}"`);
    }
  }
}
