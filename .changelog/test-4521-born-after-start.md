---
section: Changed
audience: internal
---

- The nightly LSP witness's born-after-start phase now waits for the server to report the importer's missing import, creates the module only then, and polls to a deadline for the verdict to change instead of reading one call (refs #4521). The one-call row red-flaked on pyright (2 of 5 local runs) while a server that never picks the file up still reds at the deadline; a vitest case drives the phase over a real stdio language-server wire.
