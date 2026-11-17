import { definePlugin, invalid, parseEmailAddress, type Recipient, valid } from '@mailroll/core';

export default definePlugin<Recipient>(
  () =>
    Promise.resolve({
      render: (recipient) => ({ subject: 'Test subject', html: `<p>${recipient.email}</p>` }),
    }),
  () => ({
    validate: (record) => {
      const email = parseEmailAddress(record['email'] ?? '');

      if (!email.ok) {
        return invalid(email.reasons);
      }

      return record['ok'] === 'no' ? invalid(['flagged as not deliverable']) : valid({ email: email.value });
    },
  }),
);
