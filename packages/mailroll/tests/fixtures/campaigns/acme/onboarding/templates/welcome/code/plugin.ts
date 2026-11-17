import { loadCompiledTemplate } from 'mailroll';
import {
  definePlugin,
  invalid,
  parseEmailAddress,
  type Recipient,
  renderWithMarkers,
  requiredField,
  TemplateRenderError,
  valid,
} from 'mailroll/core';

interface Member extends Recipient {
  readonly firstName: string;
  readonly plan: string;
}

export default definePlugin<Member>(
  async (template) => {
    const html = await loadCompiledTemplate(template);
    const subject = template.subjectTemplate;
    const portalUrl = template.context['portalUrl'];

    if (subject === undefined || portalUrl === undefined) {
      throw new TemplateRenderError('set "subjectTemplate" and "context.portalUrl" in template.config.json');
    }

    return {
      render: (member) =>
        renderWithMarkers({
          template: html,
          subject,
          variables: { firstName: member.firstName, plan: member.plan, portalUrl },
        }),
    };
  },
  () => ({
    validate: (row) => {
      const reasons: string[] = [];
      const email = parseEmailAddress(row['email'] ?? '');

      if (!email.ok) {
        reasons.push(...email.reasons);
      }

      const firstName = requiredField(row['firstName'], 'firstName', reasons);
      const plan = requiredField(row['plan'], 'plan', reasons);

      return email.ok && reasons.length === 0 ? valid({ email: email.value, firstName, plan }) : invalid(reasons);
    },
  }),
);
