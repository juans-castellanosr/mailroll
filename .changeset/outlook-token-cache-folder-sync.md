---
'@mailroll/outlook': patch
---

Saving the token cache now also flushes its folders to disk, so a sign-in saved just before a power failure is no longer lost and does not have to be repeated. When the cache folder does not exist yet, the parent of every folder level created for it is flushed before the cache is written, and after the new cache is renamed into place its folder is flushed too. On Windows a folder flush is skipped when Windows refuses it with `EPERM`, as mailroll does for its send state; any other error still fails the save. If the rename itself fails, the temporary file is now removed and the previous cache stays in place.
