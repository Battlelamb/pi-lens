---
section: Changed
audience: internal
---

- **The AST governance sweeps share one census seam (#4606).** `tests/support/ast-census.ts` owns the pre-order walk, the single parse behind it, and the census file list with its `.js`-twin rule; each sweep keeps its own roots and admission tables, so no detector rule and no admission row moves. `tests/support/silent-catch-scan.ts`, `tests/support/worker-message-scan.ts` and `tests/clients/socket-error-listener-sweep.test.ts` load the same seam instead of a copy of the walk. A new guard derives both of its populations from code rather than from lists: the consumer set is every file whose parsed import or re-export resolves to the seam, and the site set is the child-accessor family, so a second traversal — a `namedChildren().forEach` recursion, a `child(i)`/`childCount()` loop, a destructured or reflective accessor, a call through a computed subscript key — reds by file and line. Admission is per live site with a declared count, so a verbatim copy of an admitted line reds, and a second module instance, or a list that stops matching the tree, reds too.
