---
section: Security
audience: user
---

- **Global binary lookups honour project trust (closes #4530).** Until pi trusts the project, installer and LSP discovery exclude project PATH entries and refuse resolved commands whose realpaths land in the project. Project npm configuration cannot redirect global lookups. Refusals are recorded once per session. Outside wrappers are judged by their own realpaths. Trusted projects retain their existing lookup behavior.
