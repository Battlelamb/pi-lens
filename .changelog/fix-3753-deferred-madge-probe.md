---
section: Fixed
audience: internal
---

- **Session start ensures madge once (refs #3753)** — The deferred availability probes skip tools a startup scan already covers, but madge was probed exactly when the startup scans run, so every such session ensured madge twice. The probe is gone; the startup madge scan still ensures it, and `tests/clients/runtime-session.test.ts` pins one ensure past the exports defer.
