# Worktree Sessions: User Requirements

**Status:** requirements for re-implementation on the V2 architecture
**Source:** the `bowdens/opencode` fork feature "add worktree sessions" (last carried on `dev` at `f759e4b`, based on upstream `b471c2b`)
**Companion:** `WORKTREE_FLAG_SPEC.md` is the detailed behaviour research against Claude Code. This document lists, at user level, what the fork actually delivered so that a rewrite drops nothing.

Each requirement has an ID so a re-implementation can be checked off against it. "Must" items were implemented and tested or relied on in the fork. Items marked **(gap)** were specified but only partly delivered; they are recorded so they are a deliberate choice next time, not an accident.

---

## 1. Goal

A developer can launch OpenCode with `-w` / `--worktree` and get an isolated Git checkout for that session, the same way `claude --worktree` works. Repositories that already have Claude Code worktree setup (`.worktreeinclude`, `WorktreeCreate` / `WorktreeRemove` hooks, `worktree.baseRef`) work unchanged, with no second launcher to maintain.

The session must stay isolated for its whole life. It is created before the model runs, the agent cannot write to the main checkout, the session returns to the same worktree on resume, and cleanup never deletes work the user didn't agree to lose.

## 2. Users and entry points

| Entry point | Mode | Notes |
| --- | --- | --- |
| `opencode [project] -w [name]` (TUI) | Interactive | Primary use case |
| `opencode run --mini -w [name]` | Interactive | Behaves like the TUI for cleanup |
| `opencode run -w [name] ...` | Non-interactive | Scripts, CI, automation |
| Session picker / `--continue` / `--session` | Resume | Re-enters the stored worktree |
| HTTP server / SDK clients | Resume via API | A session opened through the API is routed into its worktree |

---

## 3. Starting a worktree session

**WT-1 Flag.** `-w` and `--worktree` both start a session in a worktree, and the name is optional.
- `opencode -w feature-auth` uses the name `feature-auth`.
- `opencode -w` generates a readable, collision-resistant name (a word slug plus a short random suffix).
- The existing project positional still works: `opencode -w feature-auth .` means worktree `feature-auth`, project `.`.

**WT-2 Initial prompt.** Because the positional is already the project path, the initial prompt comes from `--prompt`: `opencode -w --prompt "do X"` and `opencode -w name --prompt "do X"`.
- On `opencode run`, `--prompt` is accepted as an alternative to the positional message. Supplying both is an error.
- The prompt is sent only after the worktree is fully ready.

**WT-3 Session name is separate.** `-n` / `--name` sets the session's display name on both the TUI and `run`. The worktree name never becomes the session name, and the session name never becomes the worktree name. The session name affects cleanup (WT-30).

**WT-4 Settings override.** `--settings <json-or-path>` adds Claude-format settings for this launch, layered on top of the other settings sources (WT-20).

**WT-5 Help text.** `--worktree`, `--name`, `--prompt` and `--settings` appear in CLI help.

**WT-6 Invalid combinations fail up front** with a clear message and a non-zero exit, before any session starts:
- `--worktree` with `--session`, `--continue` or `--fork`.
- `--worktree` with `--attach`, since a remote server cannot host a local worktree.
- `--tmux` (hidden flag, accepted only so it can be rejected): "not supported", with or without `-w`.
- A pull/merge-request style name (`#123`, or a github.com / gitlab.com URL): "not supported". It must never be treated as a literal directory name.

**WT-7 No silent fallback.** If any part of creation fails, OpenCode exits with an error. It never quietly starts a normal session in the main checkout instead.

**WT-8 Model starts last.** The model, agent, permissions and initial prompt apply to the session after it is inside the worktree. No model request happens before the worktree exists and has been validated.

---

## 4. Default creation (Git, no hooks)

**WT-10 Location and branch.** The worktree is created at `<repo-root>/.claude/worktrees/<name>/` on a new branch `worktree-<name>`. These are the same paths Claude Code uses, so both tools see the same worktrees.

**WT-11 Name rules.** Default Git creation accepts only names made of letters, digits, `_` and `-`, and `worktree-<name>` must be a valid branch name. Any other name is rejected with an explanation. Hook-based creation passes the raw name through untouched.

**WT-12 Base revision.** The base comes from Claude's `worktree.baseRef` setting:
- `fresh` (the default) fetches `origin`, capped at about 5 s and tolerant of failure. It then branches from the remote default branch (`origin/HEAD`, then `origin/main`, then `origin/master`), falling back to local `HEAD`.
- `head` branches from the current local `HEAD`, including unpushed commits.
- Uncommitted or untracked files in the main checkout never leak into the new worktree, except through WT-14.
- **(gap)** Claude only fetches when the last fetch is older than 24 h. The fork fetches every time.

**WT-13 Reuse by name.** If `.claude/worktrees/<name>` already exists and is a worktree of the same repository, it is reopened, not recreated. A directory there that is not a valid worktree of this repository is rejected, not adopted.
- **(gap)** The `fresh`-mode "reset a clean, merged worktree to the latest default branch" optimisation was not implemented. Reuse always reopens at the existing tip.

**WT-14 `.worktreeinclude`.** If `<repo-root>/.worktreeinclude` exists (gitignore syntax), files that match it and are ignored by Git are copied into the new worktree, for example `.env`. Tracked files, non-ignored files, symlinked sources and anything that would escape the worktree are never copied.

**WT-15 Preconditions.**
- The directory must be a Git repository, unless a create hook is configured (WT-21).
- The repository must have at least one commit. Otherwise the error says HEAD could not be resolved.
- If the repository has local Git filter commands (`filter.*.process` / `smudge`, e.g. LFS), creation is refused, because repository-controlled commands must not run just because `-w` was passed.

**WT-16 Unsupported settings warn, never silently ignore.** `worktree.sparsePaths` and `worktree.symlinkDirectories` each print a warning and are not applied. The checkout is full and nothing is linked. **(gap)** Both are candidates for real support.

**WT-17 Rollback.** If anything fails after `git worktree add` (verification, include copy, marker write), the new worktree and branch are removed before exiting.

**WT-18 Ownership marker.** Each worktree OpenCode creates is marked as OpenCode-owned in its Git metadata, recording branch, directory and base. Automatic cleanup only ever deletes marked worktrees, never ones the user created by hand.

---

## 5. Claude hooks compatibility

**WT-20 Settings sources.** Claude settings are read from these sources, in increasing precedence:
1. `~/.claude/settings.json`
2. `<repo>/.claude/settings.json`
3. `<repo>/.claude/settings.local.json`
4. `--settings`

Files may be JSONC. Hook lists are combined across sources, and an identical command declared twice runs once. **(gap)** Managed settings and plugin-provided hooks are not read.

**WT-21 `WorktreeCreate` replaces Git creation.** When one is configured, OpenCode does not run `git worktree add`, `.worktreeinclude` or branch creation. Instead it:
- Runs the hook command in the launch directory, with a JSON payload on stdin: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `name`. `CLAUDE_PROJECT_DIR` is set to the project root.
- Takes the last non-empty stdout line, with ANSI codes stripped, as the worktree path. A relative path resolves against the hook's directory.
- Fails startup on: a non-zero exit (stderr shown), no output, a path that does not exist or is not a directory, an absolute path containing `.`/`..` segments, a symlink traversal inside the repo, or a path that overlaps the main checkout.
- Works in a directory that is not a Git repository.

**WT-22 `WorktreeRemove` hook.** When cleanup removes the worktree, the hook runs with a `worktree_path` payload. Its failure is reported but does not block or redirect cleanup. For a hook-created worktree, OpenCode never deletes the directory itself; it only forgets the binding. Removal is the hook's job.

**WT-23 Restrictions:**
- Only `type: "command"` hooks are supported. Any other type is a startup error, never ignored.
- More than one distinct create (or remove) hook is a startup error, raised before any hook runs.
- Hook timeout is the hook's `timeout` in seconds, or 600 s by default.

**WT-24 Trust.**
- Interactive: when hooks are configured, the user is asked "Run the WorktreeCreate hook configured by `<repo>`?". The default is No, and declining aborts.
- Non-interactive: hooks run only with `--auto` / `--yolo` / `--dangerously-skip-permissions`. Otherwise the run fails with an explanation.

---

## 6. Inside the session: isolation

**WT-30 Working context.** The session's directory, file tools, shell tools, Git status and project instructions all resolve against the worktree.

**WT-31 Protected checkouts.** The "protected" set is:
- the launch directory,
- the repository root it belongs to,
- the main (non-bare) checkout behind the Git common directory, when launched from a linked worktree.

**WT-32 File tools.** `edit`, `write` and `apply_patch` (including move targets) refuse any path inside a protected checkout. This includes paths that reach it through a symlink placed in the worktree. Paths inside the worktree are allowed even when the worktree is nested under the protected checkout, as with `.claude/worktrees/`.

**WT-33 Shell tool.** A shell command is refused when:
- its working directory, any path-like argument, or any redirection target resolves into a protected checkout;
- its text mentions a protected checkout path;
- it redirects Git with `-C`, `--git-dir`, `--work-tree`, or `GIT_*=` environment assignments whose target is unsafe or cannot be resolved;
- its targets cannot be determined safely. Examples: command substitution, interpreters or `eval`/`xargs`/`source`, quoted or concatenated paths, executables outside a small known-safe list, unknown git subcommands, `git -c` / `--exec-path`.

Isolation fails closed: when OpenCode can't tell, it refuses rather than guesses.

**WT-34 Refusals are tool errors.** A refusal names the protected checkout and the active worktree, so the model can retry correctly. Permission approvals, including "auto"/"yolo", do not override isolation.

**WT-35 Subagents inherit isolation.** Task subagents spawned from a worktree session carry the same binding and are subject to the same restrictions.

**WT-36 Forks do not inherit.** Forking a worktree session produces a normal session in the directory the fork was launched from. The original binding is left alone.

---

## 7. Ending a session: cleanup

**WT-40 Interactive exit** (TUI, `run --mini`). The worktree is inspected for modified, staged or untracked files and for any commit since the base, whether pushed or not.

| Session | Worktree | Outcome |
| --- | --- | --- |
| Unnamed | Clean, no new commits | Removed automatically (worktree and branch) |
| Named (`--name`, `--title` on run, or renamed in-session) | Clean | Prompt "Keep this named session worktree?" |
| Any | Has work | Prompt "Keep this worktree and its changes?", with the explicit option "Remove worktree and discard work" |

- The default answer is always Keep, and cancelling means Keep.
- Renaming the session from inside the app (TUI or API title update) counts as naming it.
- A hook-created worktree always counts as "has work", so the user is always asked.

**WT-41 Non-interactive exit** (`opencode run` without `--mini`). The worktree is always kept, clean or not, and there is no prompt.

**WT-42 Safety checks before deletion.** Cleanup keeps the worktree, with a message, if:
- another live OpenCode process or session is using it (tracked via per-process owner records; dead owners are swept);
- another process holds its lifecycle lock;
- it no longer verifies as a valid, isolated worktree;
- new work appeared while the prompt was open;
- the Git ownership marker is missing.

**WT-43 Crash safety.** A crash or kill never triggers deletion. The worktree and binding remain, so the session can be resumed.

**WT-44 Removal** uses Git-aware removal and deletes only the OpenCode-created branch.

---

## 8. Resuming

**WT-50 Durable binding.** The worktree binding is stored with the session (session metadata) and in OpenCode's data directory. It holds:
- session ID, worktree name and session name;
- worktree path, launch directory and project root;
- the protected directories;
- base, branch and provenance (`git` or `hook`);
- marker and remove hook.

Sessions created for a worktree reserve their session ID up front, so the binding and the session agree. This required the session-create API to accept a caller-supplied `id`.

**WT-51 Resume without `-w`.** `--session <id>`, `--continue` and picking the session in the TUI session list all re-enter the stored worktree before the model or tools run. `--continue` picks the most recent session for the project, and it can be a worktree session.

**WT-52 TUI session switching.** Choosing a worktree session in the session list switches the TUI's working directory to that worktree.

**WT-53 Server/API resume.** A request for a worktree session through the HTTP API is routed into its worktree. The session's reported directory reflects the worktree.

**WT-54 Recovery matrix.** OpenCode never enters an unverified path.

| Situation | Interactive | Non-interactive | Binding |
| --- | --- | --- | --- |
| Worktree directory is gone | Notice; continue in the launch directory | Same | Cleared; session moved to the launch directory |
| Path is now unsafe (overlaps a protected checkout, wrong repo, moved) | Notice; continue in the launch directory | Same | Cleared |
| Verification failed (transient error) | Warn "isolation is inactive"; continue in the launch directory | Abort before the session starts | Kept for retry |
| Launched from somewhere that can't vouch for it (different repo) | Warn "isolation is inactive"; continue in the launch directory | Abort | Kept; relaunch from the parent checkout |

When interactive mode continues outside the worktree, isolation is explicitly turned off for that session, and the user is told before the model runs.

---

## 9. Concurrency

**WT-60** Two OpenCode processes can open the same worktree session. Owner registration is serialized, so neither process deletes the worktree out from under the other (WT-42).

**WT-61** Lifecycle operations (create registration, cleanup) take a per-worktree lock. A stale lock left by a dead process is reclaimed.

---

## 10. Explicitly out of scope (and must say so when used)

- `--tmux`
- PR/MR shorthand (`-w '#123'`, PR URLs)
- HTTP and MCP hook types
- Multiple create/remove hooks
- Managed and plugin settings
- In-session `EnterWorktree` / `ExitWorktree` tools
- Isolated subagents with their own worktree
- Claude's trailing positional prompt (`claude -w name "prompt"`); use `--prompt`

---

## 11. Notes for the V2 re-implementation

Upstream removed `packages/opencode` (commit `44b6938b2a`). Upstream also now has native worktree features:
- project-based worktree APIs (#48867)
- TUI worktree management and explicit session moves (#47984)
- worktree tools in core (#53981)
- a configurable worktree strategy

Before rebuilding:

1. **Decide the relationship to upstream worktrees.** The fork's managed location (`.claude/worktrees/<name>`, branch `worktree-<name>`) differs from upstream's (global data dir, `opencode/<name>`). Options:
   - make `-w` a Claude-compatible *strategy* on top of upstream's worktree service, or
   - keep it separate.

   Either way, WT-10 / WT-13 / WT-18 must hold.
2. **Make the session-to-worktree binding a first-class part of the Session record** instead of a metadata blob plus side files, so that resume, the API, subagents and forks (WT-35, WT-36, WT-50 to WT-54) are handled in one place.
3. **Check whether upstream's "explicit session moves" can carry the resume fallback** in WT-54, instead of the fork's direct database update.
4. **Shell isolation (WT-33) was the largest and most fragile piece.** Check whether upstream's portable shell scanner (#53479) offers a better hook for path-target extraction.
5. **Keep the conformance list in `WORKTREE_FLAG_SPEC.md` §19 as the test plan.** The fork's own tests covered:
   - flag parsing (WT-1, WT-2),
   - isolation including symlink escape (WT-32),
   - subagent inheritance (WT-35),
   - concurrent owner registration (WT-60).
