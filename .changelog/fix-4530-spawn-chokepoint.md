---
section: Security
audience: user
---

- **Judge project trust at the spawn seam, not at each caller (refs #4530).** Every global command lookup pi-lens starts now resolves the executable it would actually run and refuses one whose real target lands in a project pi has not trusted. That closes the last holes the per-caller guards left open: lazy `gem`/`rustup` installs, Python user-base discovery, the pip user-base follow-up, archive extraction utilities, and the analyze worker. A trusted project is unchanged, and a new caller cannot skip the judgment.
