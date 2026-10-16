---
section: Fixed
audience: internal
---

- **Every continue-on-error producer outside the LSP nightly proves it evaluated something (refs #4518)** — the APFS anchors leg, the Swift crash-watch, the PR-time LSP handshake and the complexity report now fail on a measured floor through `assertEvaluated`, which gained a `--count <producer>=<n> --floor <m>` door; the `--min-pass` pass floor, the shuffle census's missing-start check and the complexity file count fold onto it. The strictness, jscpd, yamllint, typos, taplo and mise-repro jobs carry a header naming why they need no floor. The helper no longer imports `dist/` (through `clean-signal.mjs`), so the refresh-PR job's `assert-evaluated --docs` runs on its fresh checkout instead of failing every night.
