---
section: Fixed
audience: user
---

- **`rename_file` sends a `~/…` destination to your home directory, not a `~` folder in the project (#4578)** — the destination now resolves through the same host-path seam pi's own write tools use, so `~`, a leading `@` mention prefix, pi's unicode space class and a `file://` URL all resolve as they do on a read, and a destination outside the workspace is refused by the existing rename confinement instead of being created.
