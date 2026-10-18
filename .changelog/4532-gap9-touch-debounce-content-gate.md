---
section: Fixed
audience: user
---

- **Stop re-pushing byte-identical LSP content, and stop losing a save or a revert to the same gate.** The touch debounce now decides by the bytes the client sent and by whether that document's notify queue is still sending them, so a touch whose own work outlived the window no longer sends a redundant `didChange` that clears the server's diagnostics (#4532). A still-running save does not count as sending them either: it cannot change the document, so the cached diagnostics survive it. A skipped save still reaches the server, and its mark names the content the `didSave` landed for, so a retry that saves other bytes cannot suppress the save the next saved touch owes. That mark outlives the payload bound: Incremental's eviction strips the text it keeps, never the save evidence. A standalone save whose notification fails is retried once; a failed save carried by a content push remains owed by the next saved touch. Every failed send records it (`lsp-did-save-send-failed`, `lsp-did-save-recovery-exhausted`). A client that cannot report what it holds is re-sent rather than skipped.
