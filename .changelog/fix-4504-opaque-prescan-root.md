---
section: Fixed
audience: user
---

- **A subagent session in a linked worktree now recovers its own opaque bash writes** instead of reporting `no-pending-snapshot` for a command that did write (fixes #4504). The opaque prescan keyed its `tool_call` record on the host's session cwd and its `tool_result` take on the coordinator's project root, which are the same thing only for the primary session; a concurrent secondary session (a subagent in a worktree) wrote its baseline under one root and looked it up under another. Both hooks now resolve one root through `opaquePrescanRoot` (`clients/opaque-mutation-scan.ts`), and a witness through the real `index.ts` handlers over a real linked worktree pins it red-first. The same owner now keys the head-move resync and the held-primary send, so a subagent's recovered files reach the servers that hold them; a write it names in the main checkout is no longer cleared by a scan of its own worktree.
