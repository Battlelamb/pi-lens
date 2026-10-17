---
section: Fixed
audience: internal
---

- **Nine order-dependent test files now reset the process state their siblings left behind (#4561)** — the shuffle census ratchet drops from 29 files to 19: the ast-grep, dispatch-reset and managed-bin cases restore the mocks or stubs they install, the sgconfig, batch-cache, index-2992, cwd-probe, word-index and cooldown cases reset the shared ledger, latch or telemetry ring through its own seam, and the read-bridge row is deleted now that #4549 keeps its file clean under every seed.
