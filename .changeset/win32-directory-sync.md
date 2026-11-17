---
'mailroll': patch
---

On Windows, writing the send state no longer fails because a folder cannot be flushed to disk. Windows does not let Node.js flush a folder, and the flush is refused with `EPERM`. On Windows mailroll now skips that flush when it is refused with `EPERM`; any other error, including one from opening the folder, still stops the write, and other platforms still flush the folder as before. On Windows the creation, renaming or removal of a state file is therefore not flushed explicitly: a journaling file system such as NTFS keeps the folder consistent after a crash, but the latest such change may be lost on power failure, and on a network share it depends on the server. This has not been verified on Windows yet.
