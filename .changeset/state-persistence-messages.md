---
'@mailroll/core': minor
'mailroll': minor
---

When a list's history cannot be written, the error and the logs say which write failed and what it means for the recipient:

- **Messages by stage.** `StatePersistenceError` still starts with `could not record send state`, now followed by what failed and the cause from the file system:
  - intent: `could not record send state before sending to <address>; this run did not call the provider for it, though the history may read this attempt as uncertain: <cause>`
  - outcome: `could not record send state after sending to <address>; the history will read this attempt as uncertain, so check whether it was delivered before resending: <cause>`
  - release: `could not record send state after the send to <address> stopped without the provider accepting it (it may not have been called); the history will read this attempt as uncertain: <cause>`
  - snapshot: `could not record send state snapshot; no recorded outcome is lost, and the next live run replays the journal: <cause>`
- **`recipient.unrecorded` event.** An `error` log event for each recipient whose intent, outcome or release could not be written, with `templateId`, `connectionId`, `email`, `attemptId` when there is one, `stage` and `error`. A failed snapshot has no such event. With several connections, the event and the error of a recipient on another connection can carry the cause of the write that failed first.
- **Flush events.** `state.journal_kept` now has the reason `an intent is still open`, and is logged when intents are still open after a failed write. `state.flush_failed` is logged only when writing the snapshot fails after the list already stopped on an error. Flushing no longer throws the error that was already reported; what is on disk, the error the caller receives and the recovery on the next run do not change.

No public API changes: `StatePersistenceError` has the same fields.
