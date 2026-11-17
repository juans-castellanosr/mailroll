---
'mailroll': minor
'@mailroll/core': minor
---

A list's history can only be written by the run that holds its lock. This is a breaking change for code that calls `FileStateStore` directly:

- **Writes need the lock.** `FileStateStore` refuses `append` and `compact` with `ConfigError`, and writes nothing, unless the same instance took the list's lock with `lock()` and loaded the list after taking it. Before each write it checks that the lock file still belongs to this run, so a run whose lock was deleted, taken over by another run or became unreadable stops writing. The message is `the send state of "…" · … can only be written by the store that holds its lock and loaded it after taking it (…); nothing was written`, with the reason in parentheses. Call `lock()`, run the list with `runTemplate`, which loads it, and call `release()` on the lock in a `finally` block. The CLI and `runSelection` already do this. Writes to one list are now serialized within a store.
- **One live run per list and store.** `runTemplate` refuses a second live run of the same list on the same `StateStore` instance while the first is running, with `… is already used by another live run of this state store; nothing was sent`. This applies to every store, `MemoryStateStore` included.
- **Known limit.** If someone deletes the lock of a live run by hand and starts another run on the same list, the ownership checks narrow but do not remove the chance that messages are sent twice: a suspended run that overwrites the history can erase every send the other run recorded, and a later run resends all of them; see the limits in the changeset about runs that lose their lock while they write.
