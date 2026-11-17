import type { Recipient } from '../domain/addressing/recipient';
import type { Template } from '../domain/catalog/template';
import { collectRecipients } from './collect-recipients';
import { runTemplate } from './run-engine';
import type { TemplatePlugin } from './template-plugin';
import type { RecipientValidator } from '../ports/recipient-validator';
import type { TemplateRenderer } from '../ports/template-renderer';

export function definePlugin<T extends Recipient>(
  createRenderer: (template: Template) => Promise<TemplateRenderer<T>>,
  createValidator: (template: Template) => RecipientValidator<T>,
): TemplatePlugin {
  return {
    prepare: async (template) => {
      const renderer = await createRenderer(template);
      const validator = createValidator(template);

      return {
        listRecipients: async (source) => {
          const { valid, skips } = await collectRecipients(source, validator);

          return { accepted: valid.map((v) => v.email), rejected: skips };
        },
        run: (deps) => runTemplate<T>({ ...deps, validator, renderer }),
      };
    },
  };
}
