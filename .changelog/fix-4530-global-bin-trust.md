---
section: Security
audience: user
---

- **Global binary lookups honour project trust (closes #4530)** — Until pi marks a project trusted, pi-lens no longer finds or runs a tool, package manager or language server through a lookup that lands inside the project, and project configuration no longer changes where the global lookups look. Each ignored lookup dir is logged once per session with how to trust the project. Trusted projects resolve tools as before.
