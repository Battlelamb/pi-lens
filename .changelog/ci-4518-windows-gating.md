---
section: Changed
audience: internal
---

- **`Unit tests Windows` gates instead of advising (#4518)** — the lane drops its `(advisory)` suffix, its `needs: heavy-gate` deferral and its `continue-on-error` step, so it starts on every event like the Unit shards and a failing row gates in `ci-verdict` (an absent or job-skipped row still reads green until branch protection lists the name); the two tests that kept it red on master (a 60 s budget on a 10,000-path pipeline population, and the tmp-fixture census on win32) are fixed or quarantined, and branch protection still needs `Unit tests Windows` added by hand.
