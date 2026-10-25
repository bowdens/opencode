# Fork patches

`worktree-sessions.patch` is the fork's Claude-compatible `--worktree` / `-w` feature
(commit f759e4b, based on upstream b471c2b). It is a diff against the old `packages/opencode`
layout, which upstream has since removed. It does not apply to the current tree and is kept
here until the feature is ported onto `packages/cli`, `packages/tui` and `packages/core`.

Design: see `../WORKTREE_FLAG_SPEC.md`. The last working implementation is on fork branch `dev` (800a828).
