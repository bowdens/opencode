# Specification: Claude-compatible `--worktree` / `-w`

**Status:** draft, uncommitted
**Research baseline:** Claude Code 2.1.266, macOS, September 2026
**Scope:** observable behaviour required for OpenCode's local CLI to provide the core Claude Code `--worktree` workflow, including command-form setup and cleanup hooks used by repositories.

This document specifies behaviour, not module ownership or implementation structure. `MUST`, `MUST NOT`, `SHOULD` and `MAY` are used in the RFC 2119 sense.

---

## 1. Purpose

`claude --worktree` creates an isolated checkout, starts a session inside it, records that checkout as the session's current worktree, and decides what to retain when the session ends. Reproducing only the initial `git worktree add` command is insufficient. A compatible harness must also preserve:

1. CLI parsing and generated names.
2. Base revision selection.
3. Repository setup through `.worktreeinclude` or lifecycle hooks.
4. Isolation from the main checkout.
5. Session resume into the same worktree.
6. Safe cleanup of the checkout and branch.

The primary motivation is to let a repository with existing Claude Code worktree setup scripts use OpenCode without maintaining a second launcher.

This specification defines a **core compatibility profile** for local CLI sessions and command-form `WorktreeCreate` and `WorktreeRemove` hooks. Claude's `--tmux` integration, PR/MR shorthand, HTTP and MCP hook transports, background-agent isolation, isolated subagents, `worktree.symlinkDirectories`, `worktree.sparsePaths`, and the in-session `EnterWorktree` and `ExitWorktree` tools are adjacent features. They are documented where they affect the design but are not required for core conformance. An implementation **MUST** reject or clearly warn about an unsupported adjacent feature rather than silently ignoring it.

---

## 2. Evidence and confidence

Claims use these labels:

- **[OBSERVED]**: verified against the locally installed Claude Code 2.1.266 CLI or a controlled hook probe.
- **[DOCUMENTED]**: stated in Anthropic's official Claude Code documentation as fetched on 9 September 2026.
- **[ISSUE-REPORTED]**: reported or confirmed in the public `anthropics/claude-code` issue tracker, but not independently reproduced for this specification.
- **[UNVERIFIED]**: not established by the available sources. These are implementation decisions or candidates for a dedicated probe.
- **[OPENCODE-DESIGN]**: behaviour chosen for safety or compatibility with OpenCode where Claude's behaviour is undocumented.
- **[OPENCODE-DIVERGENCE]**: an intentional difference from Claude Code, outside the core compatibility profile.

Official current documentation is normative where it is explicit. Issue reports are used to identify edge cases, not to define intended behaviour.

---

## 3. Terminology

| Term | Meaning |
| --- | --- |
| **Launch directory** | The process working directory from which the CLI is invoked. |
| **Project root** | The Git working-tree root containing the launch directory, or the launch directory for a non-Git custom-hook launch. |
| **Main checkout** | The protected source checkout from which the isolated session is launched. This may itself be a linked worktree or, for custom creation, a non-Git source tree. |
| **Session worktree** | The isolated checkout adopted by the new session. |
| **Worktree name** | The optional value consumed by `-w` / `--worktree`. It is not the session display name. |
| **Session name** | The independent display/resume name supplied by `--name` or an in-session rename. |
| **Fresh base** | The repository's remote default branch, with documented fallbacks. |
| **Head base** | The current local `HEAD` of the checkout from which creation is requested. |
| **Default creation** | Claude-compatible Git worktree creation when no `WorktreeCreate` hook replaces it. |
| **Custom creation** | Creation delegated to a configured `WorktreeCreate` hook. |

---

## 4. CLI contract

### 4.1 Flag shape

The CLI **MUST** accept both forms:

```text
-w [name]
--worktree [name]
```

The value is optional. **[OBSERVED]** Local `claude --help` reports `-w, --worktree [name]`.

When a name is supplied, it identifies the worktree request. When omitted, the harness **MUST** generate a human-readable name, such as `vectorized-seeking-pumpkin`. **[OBSERVED]**

The worktree name and session name **MUST** remain separate. Supplying `-w auth` does not imply `--name auth`. **[DOCUMENTED]**

### 4.2 Optional-value parsing

The optional argument consumes the next ordinary positional value:

```bash
claude -w ONLY_ARGUMENT
```

`ONLY_ARGUMENT` is the worktree name, not an initial prompt. **[OBSERVED]**

The option terminator leaves the worktree unnamed and preserves the following positional as the prompt:

```bash
claude -w -- "PROMPT"
```

This generated a worktree name in a controlled `WorktreeCreate` hook probe. **[OBSERVED]**

OpenCode already uses its default positional as a project path and exposes `--prompt` for an initial prompt. The implementation **MUST NOT** break `opencode <project>`. It **SHOULD** provide these unambiguous forms:

```bash
opencode -w feature-auth --prompt "implement authentication"
opencode -w --prompt "implement authentication"
```

Exact support for Claude's trailing positional prompt syntax is outside the core profile because it conflicts with OpenCode's existing project positional. **[OPENCODE-DIVERGENCE]** The explicit `--prompt` form is normative for OpenCode (§18.1).

### 4.3 Related flags

- `--tmux` requires `--worktree` in Claude Code and starts the worktree session in a tmux session. **[DOCUMENTED]** It is outside the core profile. **[OPENCODE-DIVERGENCE]**
- Model, agent, permission and initial-prompt options **MUST** apply to the session after it enters the worktree.
- A worktree request in non-interactive mode **MUST** complete creation before model execution begins.
- Unknown or invalid worktree combinations **MUST** fail before starting a session rather than silently running in the main checkout.
- OpenCode **MUST** support `--name` or an equivalent explicit session-name option because cleanup distinguishes explicitly named sessions from unnamed sessions.
- The interactive TUI and non-interactive `opencode run` entry points **MUST** support worktree mode. Both complete setup before model execution; `opencode run` follows the non-interactive cleanup semantics in §13.3.

---

## 5. Preconditions and project identity

### 5.1 Git repositories

Default creation requires:

1. A Git repository containing the launch directory.
2. At least one commit that can resolve as a base.
3. A project root and Git common directory that can be resolved safely.

In a repository with no commits, creation **MUST** fail before session startup. Claude Code reports that it failed to resolve `HEAD`. **[DOCUMENTED]**

### 5.2 Non-Git repositories

Without Git, `-w` **MUST** fail unless a `WorktreeCreate` hook supplies the checkout. A custom hook replaces the Git mechanism and may implement SVN, Perforce, Mercurial or another isolation scheme. **[DOCUMENTED]**

### 5.3 Workspace trust

An interactive request **MUST NOT** execute project-controlled setup hooks before the launch project is trusted. Claude Code requires the user to trust the project before an interactive `--worktree` launch and tells the user to run Claude normally once when trust is absent. Non-interactive Claude runs skip this trust dialog. **[DOCUMENTED]**

OpenCode **MUST** apply its own equivalent trust and permission model before running repository-controlled commands. It **MUST NOT** silently treat `-w` as permission to run arbitrary project setup.

### 5.4 Launching from a linked worktree

When launched from inside an existing linked worktree, `head` means that checkout's `HEAD`. The protected main checkout for isolation includes both the launch checkout and the canonical checkout linked through Git metadata. **[DOCUMENTED]**

The exact default destination root when launching from a linked worktree has changed in Claude Code and remains poorly documented. **[ISSUE-REPORTED]** OpenCode **SHOULD** anchor the managed destination under the Git working-tree root that contains the launch directory, not unexpectedly jump to another checkout (§18.2).

---

## 6. Names, paths and branches

### 6.1 Default destination

For default creation, the session worktree **MUST** be placed under:

```text
<project-root>/.claude/worktrees/<name>/
```

This is both the documented location and the location expected by Claude Code tooling. **[DOCUMENTED]**

Repositories **SHOULD** ignore `.claude/worktrees/` so managed checkouts do not appear as untracked content in the main checkout.

### 6.2 Default branch

For an ordinary named request, default creation **MUST** create a branch named:

```text
worktree-<name>
```

**[DOCUMENTED]**

Worktree directory names and Git branch names have different validity rules. Historical Claude versions replaced `/` with `+` in both, and issue reports dispute whether `/` should remain in the branch. **[ISSUE-REPORTED]** Exact normalization for names containing separators, control characters, `..`, platform-reserved names or invalid Git ref characters is delegated (§18.3). Simple names containing only ASCII letters, digits, `_` and `-` **MUST** retain the documented path and branch exactly when the name is not platform-reserved and `worktree-<name>` passes `git check-ref-format --branch`.

### 6.3 Generated names

When no value is supplied, the harness **MUST** generate a collision-resistant, human-readable slug and use it consistently for hook input, directory selection and branch selection. The exact word list and entropy are not part of compatibility.

### 6.4 Existing names

Passing a name whose managed directory already exists **MUST** reopen that worktree rather than create a second checkout. **[DOCUMENTED]**

With `worktree.baseRef: "fresh"`, a clean, unchanged, Claude-created worktree may be reset to the current default branch when it has no unique work left, including after its remote branch was merged and deleted. Otherwise it **MUST** reopen at its existing tip. A `head`-based or pull-request worktree **MUST NOT** be reset by this reuse optimisation. **[DOCUMENTED]**

An existing directory that is not a valid isolated checkout **MUST NOT** be silently adopted as though creation succeeded.

---

## 7. Base revision selection

### 7.1 Configuration

Claude Code accepts this setting at user, project, local and managed scopes:

```json
{
  "worktree": {
    "baseRef": "fresh"
  }
}
```

Allowed values are `fresh` and `head`; the default is `fresh`. **[DOCUMENTED]**

For compatibility with Claude-configured repositories, OpenCode **MUST** recognise `worktree.baseRef` through the same effective Claude-settings resolver used for hooks. The precedence is managed settings, CLI `--settings`, project-local settings, shared-project settings, then user settings. A future native OpenCode setting may act as an alias or a lower-precedence fallback, but **MUST NOT** override a managed Claude setting. Mixed configuration **MUST** be observable.

### 7.2 Fresh base

`fresh` **MUST** prefer the remote default branch, normally `origin/main` or `origin/master`. **[DOCUMENTED]**

Claude Code refreshes the default branch when the repository has not been fetched in the last 24 hours, caps that fetch at five seconds, and uses its locally cached ref if the fetch fails. If no usable remote default exists, it falls back to local `HEAD`. **[DOCUMENTED]**

The harness **SHOULD** match those semantics. It **MUST NOT** claim to have used a fresh remote base while silently using an unrelated stale or local ref.

### 7.3 Head base

`head` **MUST** branch from the current local `HEAD`, including unpushed commits and feature-branch state. Inside a linked worktree, it means that worktree's `HEAD`. **[DOCUMENTED]**

Uncommitted and untracked files are not part of `HEAD` and **MUST NOT** be copied by base selection. They are handled only by `.worktreeinclude`, symlink configuration or a custom hook.

### 7.4 Pull and merge requests

The worktree value may be:

- `#<number>`
- A GitHub pull request URL
- A GitLab merge request URL

The shell form beginning with `#` must be quoted. Claude Code fetches the change from `origin`, creates `.claude/worktrees/pr-<number>`, and branches from the fetched head. Host-specific fetch refs are documented as:

| Origin host | Fetch strategy |
| --- | --- |
| `github.com` | `pull/<number>/head` |
| `gitlab.com` | `merge-requests/<number>/head` |
| Other hosts | Try GitHub form, then GitLab form |

PR/MR shorthand is outside the core profile. OpenCode **MUST** either implement the documented syntax or reject it with a clear unsupported-feature error rather than misinterpret it as a literal directory name. **[OPENCODE-DIVERGENCE]**

---

## 8. Default creation lifecycle

Given a valid request without a replacing hook, the harness **MUST** perform these stages in order:

1. Resolve and validate the launch repository and project root.
2. Resolve or generate the worktree name.
3. Resolve the requested base revision.
4. Determine whether a valid existing managed worktree can be reused.
5. Create a distinct Git worktree and branch when reuse does not apply.
6. Process configured sparse-checkout and shared-directory behaviour according to §9: apply supported features, otherwise reject or clearly warn before continuing.
7. Copy eligible ignored files from `.worktreeinclude`.
8. Validate that the resulting checkout is separate from every protected checkout.
9. Bind the session to the resulting absolute path.
10. Start the OpenCode session and deliver any initial prompt.

The exact setup order above is an OpenCode design choice so that shared directories exist before ignored-file copies and every setup step completes before validation and model execution. **[OPENCODE-DESIGN]**

The model **MUST NOT** run before creation, setup and validation complete.

On a failure before session binding, the command **MUST** exit non-zero and **MUST NOT** fall back to the launch directory. Resources created by the failed attempt **SHOULD** be rolled back when that can be done without deleting pre-existing work. **[OPENCODE-DESIGN]** (§18.4)

### 8.1 Git filters

Claude Code does not execute repository-local Git filter-driver commands while creating managed worktrees because repository content can influence those commands. This means locally configured Git LFS filters may leave pointer files. It refuses creation when it cannot safely determine or neutralise repository filter drivers. **[DOCUMENTED]**

OpenCode **SHOULD** preserve this security property. It **MUST NOT** execute untrusted repository-configured filters merely because `-w` was passed.

### 8.2 Worktree lock and ownership marker

Claude Code locks a managed worktree while its agent is running and marks Git metadata for worktrees it owns. Cleanup uses that marker to avoid deleting worktrees created manually. **[DOCUMENTED]**

OpenCode **SHOULD** use equivalent ownership and liveness metadata. It **MUST NOT** remove an unmarked user-created worktree during automated retention cleanup.

---

## 9. Repository setup

### 9.1 `.worktreeinclude`

For default Git creation, the harness **MUST** look for `<project-root>/.worktreeinclude`. The file uses Git-ignore syntax. **[DOCUMENTED]**

Only a source path that satisfies both conditions may be copied:

1. It matches at least one `.worktreeinclude` pattern.
2. Git considers it ignored in the source checkout.

Tracked files **MUST NOT** be overlaid from the source checkout. Parent directories must be created as needed. Copies **MUST** remain inside the destination worktree after path normalization and symlink checks.

`.worktreeinclude` is not processed when `WorktreeCreate` replaces default creation. The hook owns all copying in that case. **[DOCUMENTED]**

### 9.2 Shared directories

Claude's `worktree.symlinkDirectories` setting contains repository-root-relative directories, such as `node_modules`, to link from the main checkout into each new worktree. The default is no links. **[DOCUMENTED]**

OpenCode **SHOULD** support this setting. It **MUST** reject absolute paths, traversal outside either checkout, and destinations that would overwrite tracked content unexpectedly.

Cleanup **MUST** remove links themselves without deleting their targets.

### 9.3 Sparse checkout

Claude's `worktree.sparsePaths` setting contains repository-root-relative directories. Root-level files and the listed directories are checked out; the default is the full tree. **[DOCUMENTED]**

OpenCode **SHOULD** support this setting. If unsupported, it **MUST** either reject the request when the setting is present or clearly warn that the checkout will not be sparse.

---

## 10. `WorktreeCreate` hook compatibility

### 10.1 Replacement semantics

If at least one applicable `WorktreeCreate` hook is configured, custom creation replaces default Git creation entirely. The harness **MUST NOT** also run `git worktree add`, process `.worktreeinclude`, apply sparse checkout, or create the default branch. **[DOCUMENTED]**

Command-hook support is **REQUIRED** for the core compatibility profile. HTTP and MCP-tool handlers are outside that profile. An unsupported configured handler **MUST** produce a clear startup error rather than being ignored. **[OPENCODE-DIVERGENCE]**

### 10.2 Hook discovery

Applicable hooks may come from:

- Managed settings.
- CLI-provided settings.
- `.claude/settings.local.json`.
- `.claude/settings.json`.
- `~/.claude/settings.json`.
- Enabled plugins.

Claude combines hook entries across scopes. An identical handler declared in more than one settings file runs once; plugin or skill copies remain distinct. Worktree events do not support matchers; a supplied matcher has no filtering effect. A handler-level `if` applies only to tool events and therefore must not be used for a worktree hook. **[DOCUMENTED]**

A minimum implementation **MUST** load command hooks from user, shared-project, project-local and CLI `--settings` sources. Those sources and worktree settings **MUST** use one resolver. Managed and plugin hook compatibility **SHOULD** follow the wider configuration system rather than being approximated locally.

### 10.3 Input

A command hook receives JSON on stdin. At minimum it contains:

```json
{
  "session_id": "<session-id>",
  "transcript_path": "<absolute-transcript-path>",
  "cwd": "<launch-directory>",
  "hook_event_name": "WorktreeCreate",
  "name": "<supplied-or-generated-name>"
}
```

The `name` sent to the hook is the supplied value before default Git path normalization. A controlled probe passed `feature/auth` unchanged. **[OBSERVED]**

The hook runs in the current launch context. `${CLAUDE_PROJECT_DIR}` compatibility, where provided, points to the original project root and does not later follow the worktree. Hook code that needs the current checkout should use the JSON `cwd` field. **[DOCUMENTED]**

### 10.4 Command output

For a command handler:

1. The last non-empty stdout line is the resulting worktree path.
2. ANSI escape sequences are removed before interpreting it.
3. Earlier stdout is ignored for path selection, but setup logs **SHOULD** go to stderr.
4. A relative path is resolved against the hook's execution directory.
5. Any non-zero exit status fails creation.
6. Missing, non-directory or unsafe output fails creation.

Unlike most Claude hooks, stdout is a path rather than a JSON decision. **[DOCUMENTED]**

The returned directory may be outside `.claude/worktrees`, but it **MUST** be normalized and validated. Literal `.` or `..` segments in an absolute returned path and symlink traversal below the repository root are rejected by Claude Code. **[DOCUMENTED]**

### 10.5 Multiple create hooks

Claude Code runs matching hooks in parallel, but its public documentation does not define how conflicting path outputs from multiple `WorktreeCreate` handlers are selected. **[UNVERIFIED]**

After deduplicating identical effective handlers, the core profile **MUST** reject multiple applicable `WorktreeCreate` command handlers before running any of them. This intentionally avoids concurrent setup side effects and undefined path arbitration. **[OPENCODE-DIVERGENCE]** (§18.5)

### 10.6 Timeout and environment

Command hooks default to a 600-second timeout and run without a controlling terminal. They inherit the parent process environment subject to normal subprocess scrubbing. `CLAUDE_ENV_FILE` is not available to `WorktreeCreate`. **[DOCUMENTED]**

The harness **SHOULD** use the configured hook timeout. Setup requiring interactive terminal input is unsupported and **SHOULD** fail clearly rather than hang indefinitely.

---

## 11. Session context after creation

After successful creation:

- The session's primary working directory **MUST** be the session worktree.
- File tools **MUST** resolve relative paths there.
- Shell tools **MUST** start there.
- Project instructions, settings, agents, skills and MCP configuration **MUST** be resolved for the worktree according to each subsystem's normal rules.
- Git status and branch information **MUST** come from the worktree, not the launch checkout.
- The session record **MUST** persist the absolute worktree path and enough identity to validate it on resume.

Hook `${CLAUDE_PROJECT_DIR}` compatibility remains anchored to the original project root, while hook input `cwd` follows the worktree and subsequent directory changes. **[DOCUMENTED]**

`SessionStart` runs after the session adopts the worktree. Repositories may use it to initialize environment variables through `CLAUDE_ENV_FILE`. A compatible implementation that supports Claude hooks **SHOULD** preserve this ordering.

For a default Git-created worktree, Claude associates the transcript with the worktree as the session moves there; resume and session discovery follow it. A hook-created worktree keeps its transcript associated with the launch directory. **[DOCUMENTED]** OpenCode may store transcripts differently, but its session listing and resume behaviour **MUST** produce the same observable result.

Project-scoped plugins and saved permission approvals are shared across worktrees of the same repository. Claude normally saves a worktree approval in the main checkout's `.claude/settings.local.json`, while shared `.claude/settings.json` follows the session's primary working directory. **[DOCUMENTED]** The core profile **SHOULD** preserve these sharing rules where the corresponding Claude configuration is supported.

The core profile does not expose `EnterWorktree` or `ExitWorktree`, so the initial worktree remains current for that session. A later implementation of those tools **MUST** treat the binding as mutable, update resume identity and transcript discovery after each transition, and apply cleanup to the worktree actually being exited. **[OPENCODE-DESIGN]**

---

## 12. Isolation from the main checkout

A worktree session is not merely a different starting directory. Claude Code actively prevents the isolated agent from writing through the main checkout. **[DOCUMENTED]**

OpenCode **MUST** enforce these invariants for the entire core-profile session:

1. `edit`, `write`, `apply_patch` and equivalent file mutation tools cannot target the protected checkout.
2. Bash, PowerShell and monitor commands cannot run with a working directory that resolves to the protected checkout.
3. Bash and monitor Git commands cannot redirect into the protected checkout through `git -C`, `--git-dir`, `GIT_DIR`, `GIT_WORK_TREE`, or a preceding `cd`.
4. A Bash or monitor command whose structure prevents safe determination of its Git target must be rejected rather than guessed safe.

Refusals **MUST** be returned as tool errors that identify the worktree boundary and allow the model to reformulate the action. Permission approval **MUST NOT** override this isolation boundary.

On Windows, path identity checks **MUST** follow filesystem case behaviour and normalize drive letters. Public issue reports show that case-sensitive comparisons have broken worktree isolation and resume. **[ISSUE-REPORTED]**

---

## 13. Interactive exit and cleanup

### 13.1 Work detection

At interactive session exit, the harness **MUST** inspect the worktree for:

- Modified tracked files.
- Staged changes.
- Untracked files.
- Every commit added since the worktree base, whether pushed or unpushed.

### 13.2 Decision table

Claude Code documents this behaviour:

| Session state | Worktree state | Behaviour |
| --- | --- | --- |
| Unnamed session | Clean, no new commits | Remove worktree and branch automatically |
| Named session | Clean, no new commits | Prompt to keep or remove |
| Any session | Changes, untracked files or new commits | Prompt to keep or remove |

Here, "named" means the session display name, not the `-w` value. **[DOCUMENTED]**

Keeping preserves both the directory and branch for later resume. Removing deletes the worktree and branch, including uncommitted and committed work that exists only there. The destructive choice **MUST** be explicit whenever work would be lost.

### 13.3 Non-interactive exit

Claude Code `-p` runs do not show an exit prompt and leave their worktrees in place. They may remain Git-locked until a later stale-lock sweep. **[DOCUMENTED]**

An OpenCode non-interactive equivalent **MUST** keep every created worktree by default, including a clean one. It may remove one only when the user supplied an explicit non-interactive cleanup option.

### 13.4 Crashes and signals

A crash or forced termination **MUST NOT** trigger destructive cleanup based on an assumption that the worktree is clean. A later sweep **MAY** release an OpenCode-owned stale lock after verifying that no owner process remains. It **MUST NOT** release user-created Git worktree locks.

---

## 14. `WorktreeRemove` hook compatibility

`WorktreeRemove` fires when the system has decided to remove a worktree: at session exit after a remove choice, after an isolated subagent finishes, or when a background session is deleted. It may therefore accompany default Git cleanup or custom cleanup. **[DOCUMENTED]**

The command hook receives:

```json
{
  "session_id": "<session-id>",
  "transcript_path": "<absolute-transcript-path>",
  "cwd": "<current-directory>",
  "hook_event_name": "WorktreeRemove",
  "worktree_path": "<absolute-worktree-path>"
}
```

The hook **MUST** use `worktree_path` as the cleanup target; `cwd` is not a substitute.

Remove hooks perform side effects only:

- They cannot block a removal already approved by the lifecycle.
- Exit code `2` has no special blocking meaning.
- Failures are logged but do not become permission decisions.
- JSON decision fields are ignored.

**[DOCUMENTED]**

When custom creation was used, the harness **MUST NOT** assume the directory is a Git worktree. A configured `WorktreeRemove` hook owns custom cleanup. Without one, the custom directory **MUST** be retained rather than deleted by an unsafe generic fallback.

For default Git creation, cleanup **MUST** use Git-aware removal, delete only the OpenCode/Claude-owned branch, remove only links rather than linked targets, and prune its own metadata safely.

---

## 15. Resume behaviour

A kept worktree is part of the session's durable identity.

When that session is resumed through the interactive picker, `--continue`, an explicit session ID, or a non-interactive entry point, OpenCode **MUST**:

1. Load the stored worktree binding.
2. Verify that the path still exists and remains safe to adopt. A Git-created worktree must remain a checkout distinct from the protected checkout. A custom hook-created directory may have no Git metadata, so verification instead uses the persisted hook provenance and path-safety record.
3. Re-enter it before model execution and before exposing file or shell tools.
4. Keep all filesystem, Git and instruction context anchored there.

The user **MUST NOT** need to pass `-w` again for a valid stored binding. Claude Code's documentation promises this, although versions through at least 2.1.233 have public reports of bare `--resume` incorrectly returning to the main checkout. **[DOCUMENTED] [ISSUE-REPORTED]** OpenCode should implement the intended behaviour, not the bug.

Claude's documented recovery matrix is:

| Verification outcome | Interactive resume | Non-interactive resume | Binding |
| --- | --- | --- | --- |
| Directory is gone | Warn and continue in launch directory | Print notice and continue | Clear |
| Verification failed transiently | Warn and continue in launch directory | Abort before session starts | Keep for retry |
| Path is verified unsafe | Warn and continue in launch directory | Abort before session starts | Clear |
| Launch context cannot vouch for the path | Warn and continue in launch directory | Abort before session starts | Keep; advise launching from the parent checkout |

OpenCode **MUST NOT** enter an unverified path. Whenever interactive mode continues outside the worktree, it **MUST** state that isolation is inactive before model execution. **[DOCUMENTED]**

Forking a conversation from a worktree-bound session **SHOULD** start in the directory from which the fork command is launched and leave the original binding untouched, matching Claude Code's documented `--fork-session` behaviour.

---

## 16. Symlink and path safety

Default creation **MUST** reject `.claude`, `.claude/worktrees`, or the selected managed worktree path when any is a symlink. Claude Code does this to prevent repository-controlled redirection outside the expected destination. **[DOCUMENTED]**

The harness **MUST**:

- Canonicalize existing ancestors before containment checks.
- Reject traversal through a symlink below the trusted repository boundary during creation.
- For a Git-created or Git-backed path, validate the Git common directory and working-tree identity before adoption.
- For a non-Git hook-created path, validate persisted hook provenance and canonical path identity without requiring Git metadata.
- Reject a destination that contains the protected checkout.
- Avoid following directory links while recursively removing a worktree.
- Reject network paths where safe worktree identity cannot be established. **[OPENCODE-DESIGN]**

An invalid or suspicious directory **MUST** be left in place for manual recovery unless the harness can prove it created the directory during the current failed transaction and that it contains no pre-existing work.

---

## 17. Resolution algorithm

Normative summary for `opencode --worktree [name]`:

1. Parse the optional worktree name without consuming OpenCode's project positional incorrectly.
2. Resolve the launch directory and the available project identity.
3. Apply trust and permission checks for project-controlled setup.
4. Generate a name when absent.
5. Load applicable worktree settings and lifecycle hooks.
6. If `WorktreeCreate` applies, run it and validate its returned directory without requiring Git metadata.
7. Otherwise require Git, resolve the project root, protected checkout, common directory and base, then reuse a valid named worktree or create the default Git worktree.
8. For default creation, apply `.worktreeinclude` and process optional sparse paths and shared directories according to §9.
9. Verify isolation, record ownership and acquire any lifecycle lock.
10. Persist the session-to-worktree binding.
11. Start the session with its working directory set to the worktree.
12. On interactive exit, inspect work and apply the cleanup decision table.
13. On resume, validate and re-enter the persisted worktree before model execution.

At no point may failure silently degrade to an unisolated session in the main checkout.

---

## 18. Decisions delegated to the implementer

### 18.1 OpenCode positional compatibility

OpenCode currently interprets its default positional as a project path, while Claude interprets it as a prompt. Preserve `opencode <project>`. The normative core-profile worktree prompt form is `opencode -w [name] --prompt <text>`. Not accepting Claude's trailing prompt positional is an intentional compatibility limit. **[OPENCODE-DIVERGENCE]**

### 18.2 Launching from a linked worktree

Use the launch worktree as the source context and place managed descendants under that checkout's `<project-root>/.claude/worktrees`. Resolve `worktree.baseRef` normally: only `head` uses the launch worktree's `HEAD`, while `fresh` follows §7.2. Git identity must come from Git metadata rather than string-prefix heuristics. This follows the intended behaviour described after Claude Code 2.1.157. **[ISSUE-REPORTED]**

### 18.3 Complex name normalization

Simple names are specified. Probe current Claude behaviour for `/`, `\\`, Unicode, whitespace, leading dots, Git ref metacharacters and platform-reserved names before promising byte-for-byte parity.

### 18.4 Failed-creation rollback

Rollback newly created branches, registrations and empty directories where ownership is certain. Preserve anything pre-existing or containing work. Exact failure-stage cleanup is not fully documented upstream.

### 18.5 Multiple create hooks

Upstream runs hook handlers concurrently but does not document path arbitration. The core profile rejects multiple create handlers before execution, avoiding undefined selection and orphaned side effects. **[OPENCODE-DIVERGENCE]**

### 18.6 Wider hook system

This specification requires command-form worktree hooks because they are the common repository setup mechanism. HTTP hooks, MCP-tool hooks, managed-only policies, plugin hooks and generic Claude hook events belong in a broader hook-compatibility design. **[OPENCODE-DIVERGENCE]**

### 18.7 `--tmux`

Claude supports `--tmux` only with `--worktree`. It is outside the core profile and must report that it is unsupported rather than being ignored. **[OPENCODE-DIVERGENCE]**

---

## 19. Conformance tests

### CLI and naming

1. `-w name` and `--worktree name` select the same worktree name.
2. `-w` with no value generates a non-empty, collision-resistant name.
3. The generated or supplied name reaches `WorktreeCreate` unchanged.
4. Worktree name and session display name remain independent.
5. `opencode <project>` still opens that project without worktree mode.
6. `--prompt` is delivered only after successful worktree setup.
7. An explicit session name is recorded independently and changes clean-exit prompting.

### Default Git creation

8. A simple name creates `.claude/worktrees/<name>` and branch `worktree-<name>`.
9. A repository without commits fails before session startup.
10. A non-Git directory fails without a custom hook.
11. `fresh` uses the remote default when available.
12. `head` uses the launch checkout's exact local `HEAD`.
13. Uncommitted source changes do not leak into a normal worktree.
14. Reusing a valid existing name opens it without creating a duplicate.
15. An invalid existing directory is rejected, not adopted.

### Setup

16. `.worktreeinclude` copies matching ignored files.
17. `.worktreeinclude` does not copy tracked or non-ignored files.
18. `.worktreeinclude` cannot escape the worktree through traversal or symlinks.
19. When shared-directory support is implemented, configured directories are linked without making their targets cleanup-owned.
20. When sparse-checkout support is implemented, sparse paths check out the requested directories and root files.

### Hooks

21. A command `WorktreeCreate` hook receives the documented JSON fields.
22. Its last non-empty stdout line selects the worktree path.
23. A relative hook result resolves against the hook working directory.
24. A non-zero create hook exit fails startup.
25. A missing or unsafe returned directory fails startup.
26. Custom creation works without Git metadata and suppresses default Git creation and `.worktreeinclude`.
27. Multiple create handlers are rejected before any handler runs.
28. `WorktreeRemove` receives the absolute path originally returned by creation.
29. A remove-hook failure cannot redirect cleanup to another path.

### Session and isolation

30. The session cwd, shell cwd, Git status and file tools all use the worktree.
31. Project instructions are loaded relative to the worktree's project root.
32. File mutation targeting the protected checkout is rejected.
33. Shell cwd and Git redirection into the protected checkout are rejected.
34. A failed isolation check never silently falls back to the main checkout.
35. Default Git and hook-created worktrees remain discoverable according to their documented transcript association.

### Cleanup and resume

36. A clean unnamed interactive session is removed automatically.
37. A clean named session prompts to keep or remove.
38. Any worktree with changes, untracked files or new commits prompts, including pushed commits.
39. Keeping preserves both directory and branch.
40. Removing a dirty worktree requires an explicit destructive choice.
41. Non-interactive exit keeps the worktree by default.
42. Resume re-enters a valid kept worktree before model execution.
43. Gone, transiently unverifiable, unsafe and unvouched worktrees follow the documented recovery matrix.
44. Automated cleanup never removes an unmarked user-created worktree.
45. Removing a worktree containing directory links leaves link targets intact.

---

## 20. Known deltas in current OpenCode

Observed in the current repository while researching this specification:

- The default CLI has no `-w` / `--worktree` option.
- The default TUI CLI has no `--name` / `-n` session-name option tied to cleanup semantics.
- OpenCode's existing worktree service creates checkouts under its global data directory rather than `<repo>/.claude/worktrees/`.
- It creates `opencode/<name>` branches rather than `worktree-<name>` branches.
- It lowercases and slugifies supplied names, appends a generated suffix on collisions, and does not reopen an existing name with Claude's reuse semantics.
- Its current Git creation starts from local `HEAD`; there is no Claude-compatible `fresh` base selection.
- It supports a database-backed project startup command, but not Claude's `WorktreeCreate` and `WorktreeRemove` command-hook protocol.
- It does not process `.worktreeinclude`, `worktree.symlinkDirectories`, or `worktree.sparsePaths` in the examined creation path.
- Worktree creation is exposed through the server/UI, not as a synchronous CLI startup transaction.
- Its service returns after scheduling checkout reset, project loading and startup scripts in a background fiber. CLI `-w` requires a separate readiness boundary before model execution.
- Removal is an explicit server/UI operation rather than Claude's interactive session-exit decision table.
- The current removal primitive force-removes registered worktrees and their branches, and recursively deletes an unregistered target, without checking an OpenCode ownership marker. It **MUST NOT** be reused for automatic lifecycle cleanup until ownership is validated.
- Session resume does not currently establish the Claude-style durable `-w` binding because CLI-created worktree sessions do not exist yet.
- The existing service already has useful primitives for creation, listing, reset, project sandbox registration and startup commands. A compatible implementation should reuse safe pieces while strengthening creation readiness and removal ownership checks.

---

## 21. Sources

Primary documentation:

- [Claude Code worktrees](https://code.claude.com/docs/en/worktrees)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code settings reference](https://code.claude.com/docs/en/settings-reference#worktree)
- [Claude Code session management](https://code.claude.com/docs/en/sessions)
- [Git worktree documentation](https://git-scm.com/docs/git-worktree)

Selected issue evidence:

- [anthropics/claude-code#85339](https://github.com/anthropics/claude-code/issues/85339): resume returning a kept worktree session to the main checkout; collaborator-confirmed through 2.1.233.
- [anthropics/claude-code#23622](https://github.com/anthropics/claude-code/issues/23622): base-branch limitations and the later `worktree.baseRef` setting.
- [anthropics/claude-code#42600](https://github.com/anthropics/claude-code/issues/42600): slash normalization in worktree and branch names.
- [anthropics/claude-code#63779](https://github.com/anthropics/claude-code/issues/63779): invocation from an existing linked worktree.
- [anthropics/claude-code#67384](https://github.com/anthropics/claude-code/issues/67384): default branch-prefix behaviour and custom-hook workaround.

Local observations used no model request. Controlled probes installed a failing `WorktreeCreate` hook so argument parsing and hook input could be observed before a session or API call began.

---

Written by Claude - review for accuracy
