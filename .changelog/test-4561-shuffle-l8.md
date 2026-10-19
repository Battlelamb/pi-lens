---
section: Fixed
audience: internal
---

- **Six more shuffle-census ratchet rows are gone: three declaration-order files isolate their own cases, three opt out per `describe` (#4561)** — the io-bridge and process-bridge-registration files capture their "no bridge yet" observation in a file-level hook, the packaging manifest suite shares one real `npm pack` through a memo so either order pays it, and the two `onTestFinished` backstop suites plus the fake-timer drain suite register in the ratchet's `byDesign` rows with `{ shuffle: false }` because the order of their cases is the mechanism under test. The pinned ratchet count drops from 19 files to 13, and `tests/scripts/ci-shuffle-census.test.ts` now checks the by-design registry in both directions: an unregistered opt-out, or a registry row with no `{ shuffle: false }` describe, reds. The reader behind that check admits only the minimal marker over the parsed syntax tree: an options object is read as a sequence (a spread or an unnameable computed key refuses even beside a readable `shuffle`, and the last key wins), and a callee resolves through any number of aliases.
