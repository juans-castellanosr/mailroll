import type { RenderedEmail } from '../domain/messaging/rendered-email';

export interface TemplateRenderer<T> {
  render(recipient: T): RenderedEmail;
}
