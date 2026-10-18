---
section: Fixed
audience: internal
---

- The declaration-file walk under a root now records `lsp-declaration-walk-unreadable` when it cannot list a subtree or stat a file for a reason other than absence, and keeps that entry's previous fingerprint instead of reporting its files deleted or created; an unresolved implicit-scope question records `lsp-implicit-scope-unknown` with the file and cause, and a rejected root deregistration records `instance-registry-deregister-root-failed` with the error in its durable metadata. A new `tests/config/silent-catch-sweep.test.ts` ratchets every `catch` handler in the shipped trees to call a record seam on every path or carry a `none: <reason>` line, pinning each file's admitted set by content identity (#4596, #4603).
