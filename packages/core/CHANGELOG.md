# @mailroll/core

## 0.2.0

### Minor Changes

- 89a4319: The send history moves to a new format, records evidence for tracing, and reports rejected CC addresses. This is a breaking change:

  - **One-way history upgrade.** The first live run that writes to a list upgrades its history to v2. The old snapshot is copied to `<stem>.json.v1-backup` and the old journal is moved to `<stem>.jsonl.v1-backup`; neither is ever overwritten. Afterwards, mailroll 0.1 refuses the list with `invalid state file`. Dry runs, test sends and `status` never upgrade; they say that the next live run will. An interrupted upgrade is finished by the next live run. The new format needs a file system with hard links. Going back to 0.1 means restoring the backups by hand, which is only safe if 0.2 never attempted a send to that list. The file-system behavior has not been verified on Windows or macOS yet.
  - **Evidence.** The history keeps `attemptId` (one per send intent, the same across its retries), `providerMessageId` when the integration returns one, `cc` (rejected CC addresses and whether a CC was required when the message was sent) and `uncertainAttemptIds` (earlier attempts that ended uncertain). It is for tracing only: `sent` still means accepted by the provider, never delivered.
  - **Rejected CC.** A message the provider accepted is never sent again because its CC was rejected. With `"ccPolicy": "required"` the run needs attention, so `needsAttention` is `true` and the CLI exits with `1`; a rejected optional CC alone does not change the exit code. The run summary and `status` count messages with a rejected CC, `send --json` adds `ccRejected`, `history` and the attention status `cc-rejected`, and `status --json` adds `history` and `evidence`.
  - **SDK types.** `TemplateState` is v2, `StateStore.load` returns `StoredTemplateState` (v1 or v2), and `compact` receives a v2 state. New exports are `upgradeTemplateState`, `foldJournal`, `StoredTemplateState`, `TemplateStateV1`, `CcObservation`, and the types `RunHistory` and `HistoryPresence` from `mailroll`. `RunReport` gains `ccRejectedMessages` and `requiredCcRejectedMessages`, `TemplateRunResult` gains `history`, `ListCounts` gains both CC counts, and `ListReport` gains `evidence`. Code that builds these values or implements a `StateStore` must be updated; see the migration guide.
  - **Other changes.** A snapshot's `updatedAt` is the `at` of the last recorded recipient entry, not the time the snapshot was written. An intent superseded by a later released intent now reads as uncertain instead of being dropped. A custom `newAttemptId` must return a new, non-empty id for every send.

- 89a4319: Outlook is now an optional package, `@mailroll/outlook`, activated like any other integration. This is a breaking change for anyone who sent through Outlook:

  - Install it next to mailroll and declare it: `npm install @mailroll/outlook` and `{ "integrations": ["@mailroll/outlook"] }` in `mailroll.json`. mailroll includes no integration, so without the declaration every run, dry runs included, refuses Outlook connections.
  - `mailroll export-sent` became `mailroll-outlook export-sent`, from `@mailroll/outlook`, with the same options, output file and exit codes.
  - The Outlook exports moved from `mailroll` to `@mailroll/outlook`: `outlookIntegration` (now also the default export), `createOutlookIntegration`, `GraphClient`, `OutlookAuthProvider`, `OutlookProviderFactory`, `SentItemsReader` and their types.
  - `runSelection` activates no integration by default; pass `integrations: [outlook]`.
  - New in `mailroll`: `connectionStateLocation`, the state folder and key a connection's integration receives.

  Connections keep `"kind": "outlook"`, the secrets keep their variable names, and the token cache and send history stay where they are, with no new sign-in.

- 89a4319: When a list's history cannot be written, the error and the logs say which write failed and what it means for the recipient:

  - **Messages by stage.** `StatePersistenceError` still starts with `could not record send state`, now followed by what failed and the cause from the file system:
    - intent: `could not record send state before sending to <address>; this run did not call the provider for it, though the history may read this attempt as uncertain: <cause>`
    - outcome: `could not record send state after sending to <address>; the history will read this attempt as uncertain, so check whether it was delivered before resending: <cause>`
    - release: `could not record send state after the send to <address> stopped without the provider accepting it (it may not have been called); the history will read this attempt as uncertain: <cause>`
    - snapshot: `could not record send state snapshot; no recorded outcome is lost, and the next live run replays the journal: <cause>`
  - **`recipient.unrecorded` event.** An `error` log event for each recipient whose intent, outcome or release could not be written, with `templateId`, `connectionId`, `email`, `attemptId` when there is one, `stage` and `error`. A failed snapshot has no such event. With several connections, the event and the error of a recipient on another connection can carry the cause of the write that failed first.
  - **Flush events.** `state.journal_kept` now has the reason `an intent is still open`, and is logged when intents are still open after a failed write. `state.flush_failed` is logged only when writing the snapshot fails after the list already stopped on an error. Flushing no longer throws the error that was already reported; what is on disk, the error the caller receives and the recovery on the next run do not change.

  No public API changes: `StatePersistenceError` has the same fields.

- 89a4319: A list's history can only be written by the run that holds its lock. This is a breaking change for code that calls `FileStateStore` directly:

  - **Writes need the lock.** `FileStateStore` refuses `append` and `compact` with `ConfigError`, and writes nothing, unless the same instance took the list's lock with `lock()` and loaded the list after taking it. Before each write it checks that the lock file still belongs to this run, so a run whose lock was deleted, taken over by another run or became unreadable stops writing. The message is `the send state of "…" · … can only be written by the store that holds its lock and loaded it after taking it (…); nothing was written`, with the reason in parentheses. Call `lock()`, run the list with `runTemplate`, which loads it, and call `release()` on the lock in a `finally` block. The CLI and `runSelection` already do this. Writes to one list are now serialized within a store.
  - **One live run per list and store.** `runTemplate` refuses a second live run of the same list on the same `StateStore` instance while the first is running, with `… is already used by another live run of this state store; nothing was sent`. This applies to every store, `MemoryStateStore` included.
  - **Known limit.** If someone deletes the lock of a live run by hand and starts another run on the same list, the ownership checks narrow but do not remove the chance that messages are sent twice: a suspended run that overwrites the history can erase every send the other run recorded, and a later run resends all of them; see the limits in the changeset about runs that lose their lock while they write.
