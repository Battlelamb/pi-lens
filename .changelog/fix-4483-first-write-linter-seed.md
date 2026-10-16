---
section: Fixed
audience: user
---

- **Linters no longer stop the first edit on errors the file already had (refs #4483)** — on a file's first write or edit in a session, every existing linter error became a `🔴 STOP` blocker, because the delta baseline only existed after that first check. Before the host writes, pi-lens now runs the file's linters over its current bytes once, and the first check reports their old errors as `ℹ Pre-existing: … not blocking` instead. An error the edit caused still blocks, even at a line it did not change, and so does an old error on a line the edit changed or a second copy of one. A whole-file `write` follows the same rules. The capture waits at most 500 ms on the first edit of each file; at most four captures run concurrently and abandoned captures are cancelled. If it runs out or capacity is full, that write blocks on every error as before. Language-server and type-checker errors still block on the first write, and linters that run off the edit path (collect-later) are not covered. Pre-existing linter errors no longer close the `--lens-guard` commit gate.
