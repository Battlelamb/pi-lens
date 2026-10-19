---
section: Security
audience: user
---

- **Check project trust when selecting global tool executables (refs #4530).** Until pi trusts the project, installer candidate verification and cached results, final LSP launcher selection, Go/.NET/Ruby LSP runtime installs, and npm/pip/gem package installs refuse selected executables whose realpaths land in the project. Project npm configuration cannot redirect global lookups. Refusals are recorded once per session. Outside wrappers are judged by their own realpaths. Trusted projects retain their existing lookup behavior.
