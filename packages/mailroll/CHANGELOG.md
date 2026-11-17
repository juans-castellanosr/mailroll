# mailroll

## 0.1.0

First public release.

- CLI `mailroll`: guided menu, `send` (dry-run, test inbox, live), `status`, `build-template`, `export-sent`;
  JSON output, documented exit codes, orderly Ctrl-C.
- Node SDK `mailroll` and browser-safe `mailroll/core`.
- Per-list send history with intents, uncertain outcomes and safe resend policies.
- Microsoft Graph (Outlook) provider with delegated device-code sign-in.
- One set of email address rules everywhere: recipients, CC, test inboxes and connection mailboxes. Length limits are measured in UTF-8 bytes.
- `buildSelection`, `runSelection` and `runTemplate` validate addresses at runtime, so values from untyped callers are rejected with a `ConfigError` naming the field instead of being sent unchecked.
- A connection's `mailbox` accepts the same addresses as recipients, including internationalized ones and surrounding spaces, which are trimmed.
