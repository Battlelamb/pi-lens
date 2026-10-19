---
section: Changed
audience: internal
---

- One predicate now answers whether a mutation event is a bash-derived
  replay, and both readers (`mutating-tool` and `runtime-tool-result`) call
  it instead of spelling the marker check inline (closes #4623). Behaviour
  is unchanged. Contributed by @Don-Yin.
