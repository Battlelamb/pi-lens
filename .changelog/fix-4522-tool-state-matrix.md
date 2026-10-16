---
section: Fixed
audience: user
---

- **Tool crashes and timeouts no longer read as clean files; ktlint findings are preserved (refs #4522)** — shellcheck, shfmt and fish_indent now report no verdict when they fail to answer, and ktlint 1.8.0 output is parsed correctly. A tool-state matrix over captured runner output holds the line: only a clean run may read clean.
