---
section: Changed
audience: internal
---

- `scripts/check-pr-body.mjs` now refuses a body that names a record literal under `## Observability` unless a test vitest collects and runs reads it back: the record's full name in an assertion, a comparison, a `case` label or a record-keyed row, inside a test or a module-scope helper one of them calls — never a test title, a `console.log` argument, a skipped test or an excluded tree — over blanked test source, with the collected set read from `vitest.config.ts` (#4597). A record is named whatever the spelling (a backticked span, a bare word, a link label), the declaration that holds the read-back may be spelled with a bracket link or an alias, and a declaration form the rule cannot classify contributes nothing: a skipped or unparsable declaration never counts as a read. The rule is the mechanical half of `docs/pi-lens-fixer.md`'s record rule; `none: <reason>` stays valid, and a probe that cannot run says so instead of passing.
