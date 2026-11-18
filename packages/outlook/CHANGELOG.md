# @mailroll/outlook

## 0.2.0

### Minor Changes

- 89a4319: Outlook is now an optional package, `@mailroll/outlook`, activated like any other integration. This is a breaking change for anyone who sent through Outlook:

  - Install it next to mailroll and declare it: `npm install @mailroll/outlook` and `{ "integrations": ["@mailroll/outlook"] }` in `mailroll.json`. mailroll includes no integration, so without the declaration every run, dry runs included, refuses Outlook connections.
  - `mailroll export-sent` became `mailroll-outlook export-sent`, from `@mailroll/outlook`, with the same options, output file and exit codes.
  - The Outlook exports moved from `mailroll` to `@mailroll/outlook`: `outlookIntegration` (now also the default export), `createOutlookIntegration`, `GraphClient`, `OutlookAuthProvider`, `OutlookProviderFactory`, `SentItemsReader` and their types.
  - `runSelection` activates no integration by default; pass `integrations: [outlook]`.
  - New in `mailroll`: `connectionStateLocation`, the state folder and key a connection's integration receives.

  Connections keep `"kind": "outlook"`, the secrets keep their variable names, and the token cache and send history stay where they are, with no new sign-in.

### Patch Changes

- 89a4319: Saving the token cache now also flushes its folders to disk, so a sign-in saved just before a power failure is no longer lost and does not have to be repeated. When the cache folder does not exist yet, the parent of every folder level created for it is flushed before the cache is written, and after the new cache is renamed into place its folder is flushed too. On Windows a folder flush is skipped when Windows refuses it with `EPERM`, as mailroll does for its send state; any other error still fails the save. If the rename itself fails, the temporary file is now removed and the previous cache stays in place.
- Updated dependencies [89a4319]
- Updated dependencies [89a4319]
- Updated dependencies [89a4319]
- Updated dependencies [89a4319]
- Updated dependencies [89a4319]
- Updated dependencies [89a4319]
- Updated dependencies [89a4319]
- Updated dependencies [89a4319]
  - mailroll@0.2.0
  - @mailroll/core@0.2.0
