---
section: Fixed
audience: user
---

- **Nested Python projects keep their own language server (closes #4547)** — For Python language servers, a directory marked only by `requirements.txt`, `setup.py` or `setup.cfg` is now a project boundary, so its Python files are no longer served by an ancestor's pyright client without the project's own config or virtualenv. Before, such files could report unresolved imports, depending on which Python file was opened first.
