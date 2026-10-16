---
section: Security
audience: user
---

- **Global binary lookups honour project trust (closes #4530)** — Until pi marks a project trusted, installer and LSP lookups and their child environments exclude PATH entries inside the project, including directory symlinks, and project configuration no longer changes where the global lookups look. Each ignored lookup dir is logged once per session with how to trust the project. Availability checks and archive extractors use the same scoped PATH. A compiler lookup whose PATH entries were refused emits only the trust notice; a genuinely missing compiler still emits the resolution notice. Trusted projects and MCP hosts resolve tools as before.
