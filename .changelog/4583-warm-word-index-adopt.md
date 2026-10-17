---
section: Fixed
audience: user
---

- **`symbol_search` answers as soon as a cold word-index build finishes (closes #4583)** — a query that arrived during the build cached "index is building" for that root, and nothing refreshed it, so every later call in the same process replayed the building hint and re-triggered a build over the index already on disk. A completed build (cold, or the session-start rebuild and reuse paths) now hands its index to that warm entry, so the next query searches it.
