---
section: Fixed
audience: user
---

- **A held document keeps its drift record at the record cap, so an untracked edit still heals**: the capped record set evicted by insertion order alone, so a workspace sweep (one touch per project file, every document still open) unbound the earliest files — the server kept answering from their pre-edit bytes with nothing left to compare disk against (closes #4503). Eviction now skips every record whose document a live server still holds, and the held-document count bounds the set instead of the cap alone; one `lsp_document_drift_cap` row per session names the first crossing.
