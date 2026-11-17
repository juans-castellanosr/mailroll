---
'mailroll': minor
'@mailroll/core': minor
'@mailroll/outlook': minor
---

Outlook is now an optional package, `@mailroll/outlook`, activated like any other integration. This is a breaking change for anyone who sent through Outlook:

- Install it next to mailroll and declare it: `npm install @mailroll/outlook` and `{ "integrations": ["@mailroll/outlook"] }` in `mailroll.json`. mailroll includes no integration, so without the declaration every run, dry runs included, refuses Outlook connections.
- `mailroll export-sent` became `mailroll-outlook export-sent`, from `@mailroll/outlook`, with the same options, output file and exit codes.
- The Outlook exports moved from `mailroll` to `@mailroll/outlook`: `outlookIntegration` (now also the default export), `createOutlookIntegration`, `GraphClient`, `OutlookAuthProvider`, `OutlookProviderFactory`, `SentItemsReader` and their types.
- `runSelection` activates no integration by default; pass `integrations: [outlook]`.
- New in `mailroll`: `connectionStateLocation`, the state folder and key a connection's integration receives.

Connections keep `"kind": "outlook"`, the secrets keep their variable names, and the token cache and send history stay where they are, with no new sign-in.
