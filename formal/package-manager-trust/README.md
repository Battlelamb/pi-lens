# Package-manager trust scope (#4566 round 10)

`clients/package-manager.ts` captures the caller root and trust scope in the
availability and global-directory cache/flight key. Two roots and both admission
scopes can switch while probes are pending. A settled probe writes its captured
key; a lookup may read only its own root's answer. `Ambient.cfg` reproduces the
old root-free identity; `Scoped.cfg` checks the carried-root identity.

The model abstracts manager names, filesystem evidence, bounded FIFO eviction,
and subprocess failure. They do not change which root owns a successful answer.
Eviction only removes an answer and causes another probe. Unknown and untrusted
share admission and therefore one scope; trusted has the other scope.

`FinalSelection.tla` covers trust changes and executable replacement between
initial discovery and spawn, including installer cache reuse. Admission uses the selected executable and the
current trust answer. Outside executables remain admitted in every trust state.

The installer PATH availability memo also keys its verdict by caller root,
search PATH, and current trust. A non-trusted refusal cannot answer after trust
changes to trusted.
