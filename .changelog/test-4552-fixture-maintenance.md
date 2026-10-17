---
section: Fixed
audience: internal
---

- The shared Git fixture helpers point `GIT_CONFIG_GLOBAL` at one checked-in
  policy file, `tests/fixtures/git-fixture-global.gitconfig`, which disables
  background maintenance (`maintenance.auto=false`, `gc.auto=0`) for every
  fixture Git process. A fixture `git commit` therefore no longer forks the
  detached `git maintenance run --auto --quiet --detach` child that outlived
  the cell and wrote inside the fixture's `.git` while `afterEach` teardown
  removed it, so the gating Unit shard stops failing
  `tests/scripts/check-pr-body.test.ts` in teardown with `ENOTEMPTY` instead of
  in an assertion (closes #4552).
