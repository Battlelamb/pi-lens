---
section: Changed
audience: internal
---

- The out-of-band disk look now publishes one `DiskChange` (`clients/disk-changes.ts`) instead of calling the LSP service and the diagnostics-cache clock itself, and the project sequence gains a bulk writer (`recordProjectMutations`) that allocates N paths in one locked change-log append with the single writer's lock-failure semantics. This is slice 1 of #4535 (publisher foundation): the migrated wires are the out-of-band look's two consumers, and the remaining detectors follow in later slices.
