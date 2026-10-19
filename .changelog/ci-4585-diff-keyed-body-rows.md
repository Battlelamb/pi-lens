---
section: Fixed
audience: internal
---

- Tie PR-body evidence to changed test files, changed production guards, and Windows-sensitive launch and path seams (#4585). Row 1 is file-level: one fenced red-first transcript naming the file, or a Controls row naming it with a reason. A whole-file deletion owes no row, a move owes nothing while a copy does, a `mutation:` fence needs an explicit RED/FAIL result, and a Windows row that names a bare basename is not a generic read (#4605).
