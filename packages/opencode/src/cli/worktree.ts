import { Global } from "@opencode-ai/core/global"
import { Slug } from "@opencode-ai/core/util/slug"
import { SessionID } from "@/session/schema"
import ignore from "ignore"
import { parse } from "jsonc-parser"
import path from "node:path"
import stripAnsi from "strip-ansi"

export const MetadataKey = "opencode.worktree"

type Hook = {
  command: string
  timeout: number
}

export type Binding = {
  version: 1
  sessionID: string
  name: string
  sessionName?: string
  directory: string
  launchDirectory: string
  projectRoot: string
  protectedDirectories: string[]
  base: string
  branch?: string
  provenance: "git" | "hook"
  marker?: string
  removeHook?: Hook
  timeCreated: number
}

type State = {
  binding: Binding
  created: boolean
  claimed: boolean
  ownerFile: string
}

type Args = {
  worktree?: string
  name?: string
  settings?: string
  session?: string
  continue?: boolean
  fork?: boolean
  attach?: string
  tmux?: boolean
  auto?: boolean
  yolo?: boolean
  dangerouslySkipPermissions?: boolean
  "dangerously-skip-permissions"?: boolean
}

type ClaudeSettings = {
  worktree?: {
    baseRef?: "fresh" | "head"
    symlinkDirectories?: string[]
    sparsePaths?: string[]
  }
  hooks?: Record<string, unknown>
}

const states = new WeakMap<object, State>()
const SIMPLE_NAME = /^[A-Za-z0-9_-]+$/
const ANSI_ESCAPE = /(?:\u001B\[[0-?]*[ -/]*[@-~])/g

export function requested(args: Args) {
  return args.worktree !== undefined
}

export function state(args: object) {
  return states.get(args)
}

export function sessionInput(args: object) {
  const current = states.get(args)
  if (!current?.created || current.claimed) return undefined
  current.claimed = true
  return {
    id: current.binding.sessionID,
    title: current.binding.sessionName,
    metadata: { [MetadataKey]: current.binding },
  }
}

export async function resolveDirectory(args: Args, launchDirectory: string, options?: { interactive?: boolean }) {
  const launch = await canonical(launchDirectory)
  if (args.tmux && !requested(args)) throw new Error("--tmux requires --worktree and is not supported")
  if (requested(args)) return create(args, launch, options?.interactive === true)
  if (args.fork) return launch

  const persisted = args.continue ? await latestPersistedBinding(launch) : undefined
  const binding = args.session
    ? ((await readBinding(args.session)) ?? (await readSessionBinding(args.session)))
    : args.continue
      ? persisted?.available
        ? persisted.binding
        : await latestBinding(launch)
      : undefined
  if (!binding) return launch

  const vouched = await canVouch(binding, launch)
  if (!vouched) {
    if (!options?.interactive)
      throw new Error(`Launch directory cannot verify the worktree for session ${binding.sessionID}`)
    args.session = binding.sessionID
    args.continue = false
    process.env.OPENCODE_WORKTREE_DISABLED_SESSION = binding.sessionID
    process.stderr.write(
      `Launch directory cannot verify the worktree for session ${binding.sessionID}; isolation is inactive.\n`,
    )
    return launch
  }

  const verified = await verify(binding)
  if (verified === "gone" || verified === "unsafe") {
    await removeBinding(binding.sessionID)
    args.session = binding.sessionID
    args.continue = false
    process.env.OPENCODE_WORKTREE_DISABLED_SESSION = binding.sessionID
    await moveSessionRecord(binding.sessionID, launch)
    process.stderr.write(`Worktree for session ${binding.sessionID} is unavailable; continuing in ${launch}.\n`)
    return launch
  }
  if (verified !== "valid") {
    if (!options?.interactive) throw new Error(`Could not verify the worktree for session ${binding.sessionID}`)
    args.session = binding.sessionID
    args.continue = false
    process.env.OPENCODE_WORKTREE_DISABLED_SESSION = binding.sessionID
    process.stderr.write(`Could not verify the worktree for session ${binding.sessionID}; isolation is inactive.\n`)
    return launch
  }
  if (args.continue) {
    args.session = binding.sessionID
    args.continue = false
  }
  const adopted = { ...binding }
  const ownerFile = await registerOwner(adopted)
  await writeBinding(adopted)
  states.set(args, { binding: adopted, created: false, claimed: true, ownerFile })
  return adopted.directory
}

async function create(args: Args, launchDirectory: string, interactive: boolean) {
  if (args.session || args.continue || args.fork)
    throw new Error("--worktree cannot be combined with session resume or fork options")
  if (args.attach) throw new Error("--worktree cannot be used with --attach")
  if (args.tmux) throw new Error("--tmux worktree sessions are not supported")

  const supplied = args.worktree?.trim()
  if (supplied && (supplied.startsWith("#") || /^https?:\/\/(?:www\.)?(?:github|gitlab)\.com\//i.test(supplied))) {
    throw new Error("Pull request and merge request worktrees are not supported")
  }

  const name = supplied || `${Slug.create()}-${crypto.randomUUID().slice(0, 6)}`
  const sessionID = SessionID.create()
  const repository = await discover(launchDirectory)
  const projectRoot = repository?.worktree ?? launchDirectory
  const settings = await loadSettings(projectRoot, args.settings)
  const createHooks = hooks(settings, "WorktreeCreate")
  const removeHooks = hooks(settings, "WorktreeRemove")
  if (createHooks.length > 1) throw new Error("Multiple WorktreeCreate command hooks are not supported")
  if (removeHooks.length > 1) throw new Error("Multiple WorktreeRemove command hooks are not supported")
  if ((createHooks.length || removeHooks.length) && interactive) {
    const prompts = await import("@clack/prompts")
    const trusted = await prompts.confirm({
      message: `Run the WorktreeCreate hook configured by ${projectRoot}?`,
      initialValue: false,
    })
    if (prompts.isCancel(trusted) || !trusted)
      throw new Error("Worktree creation cancelled; project hook was not trusted")
  }
  if (
    (createHooks.length || removeHooks.length) &&
    !interactive &&
    !args.auto &&
    !args.yolo &&
    !args.dangerouslySkipPermissions &&
    !args["dangerously-skip-permissions"]
  ) {
    throw new Error("Non-interactive worktree hooks require --auto or --dangerously-skip-permissions")
  }

  const transcriptPath = path.join(Global.Path.data, "worktree-transcript", `${sessionID}.jsonl`)
  await Bun.write(transcriptPath, "")
  const protectedDirectories = repository
    ? [
        ...new Set(
          [launchDirectory, repository.worktree, await canonicalGitMain(repository.commonDirectory)].filter(Boolean),
        ),
      ]
    : [launchDirectory]

  const result = createHooks[0]
    ? await createFromHook({
        hook: createHooks[0],
        sessionID,
        transcriptPath,
        launchDirectory,
        projectRoot,
        protectedDirectories,
        name,
      })
    : await createFromGit({ repository, settings, name, projectRoot })
  const binding: Binding = {
    version: 1,
    sessionID,
    name,
    sessionName: args.name,
    directory: result.directory,
    launchDirectory,
    projectRoot,
    protectedDirectories,
    base: result.base,
    branch: "branch" in result ? result.branch : undefined,
    provenance: result.provenance,
    marker: "marker" in result ? result.marker : undefined,
    removeHook: removeHooks[0],
    timeCreated: Date.now(),
  }
  const ownerFile = await registerOwner(binding)
  await writeBinding(binding)
  states.set(args, { binding, created: true, claimed: false, ownerFile })
  return binding.directory
}

async function createFromHook(input: {
  hook: Hook
  sessionID: string
  transcriptPath: string
  launchDirectory: string
  projectRoot: string
  protectedDirectories: string[]
  name: string
}) {
  const result = await shell(input.hook.command, input.launchDirectory, {
    timeout: input.hook.timeout,
    stdin: JSON.stringify({
      session_id: input.sessionID,
      transcript_path: input.transcriptPath,
      cwd: input.launchDirectory,
      hook_event_name: "WorktreeCreate",
      name: input.name,
    }),
    env: { CLAUDE_PROJECT_DIR: input.projectRoot },
  })
  if (result.code !== 0) throw new Error(result.stderr.trim() || `WorktreeCreate hook exited with code ${result.code}`)
  const output = stripAnsi(result.stdout.replace(ANSI_ESCAPE, ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  if (!output) throw new Error("WorktreeCreate hook did not return a worktree path")
  if (path.isAbsolute(output) && output.split(/[\\/]/).some((part) => part === "." || part === "..")) {
    throw new Error("WorktreeCreate hook returned an unsafe path")
  }
  const selected = path.resolve(input.launchDirectory, output)
  if (contains(input.projectRoot, selected)) await assertNoSymlink(input.projectRoot, selected)
  const directory = await canonical(selected)
  if (!(await stat(directory))?.isDirectory()) {
    throw new Error("WorktreeCreate hook did not return an existing directory")
  }
  assertCustomSeparate(directory, input.protectedDirectories)
  return { directory, base: "hook", provenance: "hook" as const }
}

async function createFromGit(input: {
  repository: Repository | undefined
  settings: ClaudeSettings
  name: string
  projectRoot: string
}) {
  if (!input.repository) throw new Error("--worktree requires a Git repository or a WorktreeCreate hook")
  if (!SIMPLE_NAME.test(input.name)) {
    throw new Error(
      "Worktree names for default Git creation may contain only letters, digits, underscores, and hyphens",
    )
  }
  const branch = `worktree-${input.name}`
  const ref = await git(input.projectRoot, ["check-ref-format", "--branch", branch])
  if (ref.code !== 0) throw new Error(`Invalid worktree branch name: ${branch}`)

  const root = path.join(input.projectRoot, ".claude", "worktrees")
  await assertManagedPath(input.projectRoot, root)
  const directory = path.join(root, input.name)
  await assertNoSymlink(input.projectRoot, directory)
  if ((await stat(directory))?.isDirectory()) {
    const existing = await discover(directory)
    if (!existing || !(await same(existing.commonDirectory, input.repository.commonDirectory))) {
      throw new Error(`Existing path is not a worktree for this repository: ${directory}`)
    }
    assertSeparate(existing.worktree, [input.repository.worktree])
    const currentBranch = (await git(directory, ["branch", "--show-current"])).stdout.trim()
    const markerFile = await markerPath(existing)
    const marker = await readMarker(markerFile)
    const owned = marker && marker.directory === existing.worktree && marker.branch === currentBranch
    return {
      directory: existing.worktree,
      base: marker?.base ?? (await git(directory, ["rev-parse", "HEAD"])).stdout.trim(),
      branch: owned ? marker.branch : undefined,
      provenance: "git" as const,
      marker: owned ? markerFile : undefined,
    }
  }

  const head = await git(input.projectRoot, ["rev-parse", "HEAD"])
  if (head.code !== 0 || !head.stdout.trim())
    throw new Error("Failed to resolve HEAD; the repository needs at least one commit")
  const filters = await git(input.projectRoot, [
    "config",
    "--local",
    "--get-regexp",
    "^filter\\..*\\.(process|smudge)$",
  ])
  if (filters.code === 0 && filters.stdout.trim())
    throw new Error("Repository-local Git filter commands prevent safe worktree creation")

  const baseRef =
    input.settings.worktree?.baseRef === "head"
      ? head.stdout.trim()
      : await freshBase(input.repository, head.stdout.trim())
  const resolvedBase = await git(input.projectRoot, ["rev-parse", baseRef])
  if (resolvedBase.code !== 0 || !resolvedBase.stdout.trim())
    throw new Error(`Failed to resolve worktree base: ${baseRef}`)
  const base = resolvedBase.stdout.trim()
  await mkdir(root)
  if (input.settings.worktree?.sparsePaths?.length) {
    process.stderr.write("Warning: worktree.sparsePaths is not supported; creating a full checkout.\n")
  }
  if (input.settings.worktree?.symlinkDirectories?.length) {
    process.stderr.write("Warning: worktree.symlinkDirectories is not supported and will not be applied.\n")
  }
  const created = await git(input.projectRoot, ["worktree", "add", "-b", branch, "--", directory, base])
  if (created.code !== 0) throw new Error(created.stderr.trim() || "Failed to create Git worktree")

  try {
    const repository = await discover(directory)
    if (!repository) throw new Error("Created worktree could not be verified")
    assertSeparate(repository.worktree, [input.repository.worktree])
    await copyIncluded(input.projectRoot, directory)
    const marker = await markerPath(repository)
    await Bun.write(
      marker,
      JSON.stringify({ version: 1, branch, directory: repository.worktree, base, created: Date.now() }),
    )
    return { directory: repository.worktree, base, branch, provenance: "git" as const, marker }
  } catch (error) {
    await git(input.projectRoot, ["worktree", "remove", "--force", directory])
    await git(input.projectRoot, ["branch", "-D", branch])
    throw error
  }
}

export async function finish(args: object, interactive: boolean, named = false) {
  const current = states.get(args)
  if (!current || !interactive) return
  const binding = (await readBinding(current.binding.sessionID)) ?? current.binding
  process.chdir(binding.launchDirectory)
  const release = await acquireOperationLock(binding.directory)
  if (!release) {
    process.stderr.write("Keeping worktree because another process is using its lifecycle lock.\n")
    return
  }
  try {
    if ((await verify(binding)) !== "valid") return
    if (await hasActiveOwner(binding, current.ownerFile)) {
      process.stderr.write("Keeping worktree because another session is active.\n")
      return
    }

    const work = await hasWork(binding)
    const needsPrompt = named || Boolean(binding.sessionName) || work
    if (needsPrompt) {
      const prompts = await import("@clack/prompts")
      const answer = await prompts.select({
        message: work ? "Keep this worktree and its changes?" : "Keep this named session worktree?",
        options: [
          { value: "keep", label: "Keep worktree" },
          { value: "remove", label: work ? "Remove worktree and discard work" : "Remove worktree" },
        ],
        initialValue: "keep",
      })
      if (prompts.isCancel(answer) || answer !== "remove") return
    }
    if (await hasActiveOwner(binding, current.ownerFile)) return
    if (!work && (await hasWork(binding))) {
      process.stderr.write("Keeping worktree because work appeared while cleanup was pending.\n")
      return
    }
    if (binding.provenance === "git" && (!binding.marker || !(await Bun.file(binding.marker).exists()))) {
      process.stderr.write("Keeping worktree because its OpenCode ownership marker is missing.\n")
      return
    }
    await remove(binding)
    states.delete(args)
  } finally {
    await release()
    const fs = await import("node:fs/promises")
    await fs.rm(current.ownerFile, { force: true })
  }
}

async function remove(binding: Binding) {
  if (binding.removeHook) {
    const transcriptPath = path.join(Global.Path.data, "worktree-transcript", `${binding.sessionID}.jsonl`)
    const result = await shell(binding.removeHook.command, binding.directory, {
      timeout: binding.removeHook.timeout,
      stdin: JSON.stringify({
        session_id: binding.sessionID,
        transcript_path: transcriptPath,
        cwd: binding.directory,
        hook_event_name: "WorktreeRemove",
        worktree_path: binding.directory,
      }),
      env: { CLAUDE_PROJECT_DIR: binding.projectRoot },
    })
    if (result.code !== 0)
      process.stderr.write(result.stderr || `WorktreeRemove hook exited with code ${result.code}\n`)
  }
  if (binding.provenance === "hook") {
    await removeBinding(binding.sessionID)
    return
  }
  if (!binding.marker || !(await Bun.file(binding.marker).exists())) {
    throw new Error("Refusing to remove a worktree without an OpenCode ownership marker")
  }
  const removed = await git(binding.projectRoot, ["worktree", "remove", "--force", binding.directory])
  if (removed.code !== 0) throw new Error(removed.stderr.trim() || "Failed to remove worktree")
  if (binding.branch) {
    const branch = await git(binding.projectRoot, ["branch", "-D", binding.branch])
    if (branch.code !== 0) throw new Error(branch.stderr.trim() || "Failed to remove worktree branch")
  }
  await removeBinding(binding.sessionID)
}

async function hasWork(binding: Binding) {
  if (binding.provenance !== "git") return true
  const status = await git(binding.directory, ["status", "--porcelain", "--untracked-files=all"])
  if (status.code !== 0 || status.stdout.trim()) return true
  const commits = await git(binding.directory, ["rev-list", "--count", `${binding.base}..HEAD`])
  return commits.code !== 0 || Number.parseInt(commits.stdout.trim(), 10) > 0
}

async function verify(binding: Binding): Promise<"valid" | "gone" | "unsafe" | "failed"> {
  if (!(await stat(binding.directory))?.isDirectory()) return "gone"
  try {
    const directory = await canonical(binding.directory)
    if (binding.protectedDirectories.some((protectedDirectory) => contains(directory, protectedDirectory)))
      return "unsafe"
    if (binding.provenance === "hook") return directory === binding.directory ? "valid" : "unsafe"
    const repository = await discover(directory)
    const launch = await discover(binding.projectRoot)
    if (!repository || !launch) return "unsafe"
    if (!(await same(repository.commonDirectory, launch.commonDirectory))) return "unsafe"
    return repository.worktree === directory ? "valid" : "unsafe"
  } catch {
    return "failed"
  }
}

async function canVouch(binding: Binding, launchDirectory: string) {
  if (binding.provenance === "hook") {
    return contains(binding.launchDirectory, launchDirectory) || contains(launchDirectory, binding.launchDirectory)
  }
  const launch = await discover(launchDirectory)
  const project = await discover(binding.projectRoot)
  return Boolean(launch && project && (await same(launch.commonDirectory, project.commonDirectory)))
}

async function freshBase(repository: Repository, fallback: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  await git(repository.worktree, ["fetch", "origin", "--prune"], controller.signal).catch(() => undefined)
  clearTimeout(timeout)

  const symbolic = await git(repository.worktree, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
  if (symbolic.code === 0 && symbolic.stdout.trim()) return symbolic.stdout.trim()
  for (const candidate of ["origin/main", "origin/master"]) {
    if ((await git(repository.worktree, ["rev-parse", "--verify", candidate])).code === 0) return candidate
  }
  return fallback
}

async function copyIncluded(sourceRoot: string, destinationRoot: string) {
  const file = Bun.file(path.join(sourceRoot, ".worktreeinclude"))
  if (!(await file.exists())) return
  const matcher = ignore().add(await file.text())
  const listed = await git(sourceRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])
  if (listed.code !== 0) throw new Error(listed.stderr.trim() || "Failed to resolve .worktreeinclude files")
  const files = listed.stdout.split("\0").filter((item) => item && matcher.ignores(item))
  for (const relative of files) {
    const source = path.resolve(sourceRoot, relative)
    const destination = path.resolve(destinationRoot, relative)
    if (!contains(sourceRoot, source) || !contains(destinationRoot, destination))
      throw new Error(".worktreeinclude path escapes the worktree")
    const info = await stat(source, true)
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe .worktreeinclude source: ${relative}`)
    await assertNoSymlink(destinationRoot, path.dirname(destination))
    await mkdir(path.dirname(destination))
    await Bun.write(destination, Bun.file(source))
  }
}

async function loadSettings(projectRoot: string, cli?: string): Promise<ClaudeSettings> {
  const files = [
    path.join(Global.Path.home, ".claude", "settings.json"),
    path.join(projectRoot, ".claude", "settings.json"),
    path.join(projectRoot, ".claude", "settings.local.json"),
  ]
  const values = await Promise.all(files.map(readSettings))
  if (cli) values.push(await readSettingsValue(cli))
  return values.reduce(mergeSettings, {})
}

async function readSettings(file: string) {
  if (!(await Bun.file(file).exists())) return {}
  return readSettingsValue(await Bun.file(file).text())
}

async function readSettingsValue(value: string): Promise<ClaudeSettings> {
  const source = value.trim().startsWith("{") ? value : await Bun.file(path.resolve(value)).text()
  const errors: import("jsonc-parser").ParseError[] = []
  const result = parse(source, errors)
  if (errors.length || !result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid Claude settings")
  return result as ClaudeSettings
}

function mergeSettings(left: ClaudeSettings, right: ClaudeSettings): ClaudeSettings {
  const hooks = { ...(left.hooks ?? {}) }
  for (const [event, entries] of Object.entries(right.hooks ?? {})) {
    hooks[event] = [...asArray(hooks[event]), ...asArray(entries)]
  }
  return {
    ...left,
    ...right,
    worktree: { ...left.worktree, ...right.worktree },
    hooks,
  }
}

function hooks(settings: ClaudeSettings, event: string) {
  const result = asArray(settings.hooks?.[event]).flatMap((group) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) return []
    return asArray((group as Record<string, unknown>).hooks).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return []
      const item = entry as Record<string, unknown>
      if (item.type !== "command") throw new Error(`Unsupported ${event} hook type: ${String(item.type)}`)
      if (typeof item.command !== "string" || !item.command.trim()) throw new Error(`Invalid ${event} command hook`)
      return [{ command: item.command, timeout: typeof item.timeout === "number" ? item.timeout * 1000 : 600_000 }]
    })
  })
  return result.filter(
    (item, index) =>
      result.findIndex((other) => other.command === item.command && other.timeout === item.timeout) === index,
  )
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

type Repository = { worktree: string; gitDirectory: string; commonDirectory: string }

async function discover(directory: string): Promise<Repository | undefined> {
  const root = await git(directory, ["rev-parse", "--show-toplevel"])
  const gitDirectory = await git(directory, ["rev-parse", "--git-dir"])
  const commonDirectory = await git(directory, ["rev-parse", "--git-common-dir"])
  if (root.code !== 0 || gitDirectory.code !== 0 || commonDirectory.code !== 0) return undefined
  return {
    worktree: await canonical(path.resolve(directory, root.stdout.trim())),
    gitDirectory: await canonical(path.resolve(directory, gitDirectory.stdout.trim())),
    commonDirectory: await canonical(path.resolve(directory, commonDirectory.stdout.trim())),
  }
}

async function canonicalGitMain(commonDirectory: string) {
  const bare = await git(path.dirname(commonDirectory), ["--git-dir", commonDirectory, "config", "--get", "core.bare"])
  if (bare.stdout.trim() === "true") return ""
  return canonical(path.dirname(commonDirectory))
}

async function markerPath(repository: Repository) {
  return path.join(repository.gitDirectory, "opencode-worktree.json")
}

async function assertManagedPath(projectRoot: string, root: string) {
  await assertNoSymlink(projectRoot, root)
  if (!contains(projectRoot, root)) throw new Error("Managed worktree path escapes the project root")
}

async function assertNoSymlink(root: string, target: string) {
  const relative = path.relative(root, target)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path escapes the trusted project root")
  let current = root
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const info = await stat(current, true)
    if (info?.isSymbolicLink()) throw new Error(`Refusing to traverse symlink: ${current}`)
    if (!info) break
  }
}

function assertSeparate(directory: string, protectedDirectories: string[]) {
  for (const protectedDirectory of protectedDirectories) {
    if (!protectedDirectory) continue
    if (contains(directory, protectedDirectory)) {
      throw new Error(`Worktree is not isolated from protected checkout: ${protectedDirectory}`)
    }
  }
}

function assertCustomSeparate(directory: string, protectedDirectories: string[]) {
  for (const protectedDirectory of protectedDirectories) {
    if (!protectedDirectory) continue
    if (!contains(directory, protectedDirectory) && !contains(protectedDirectory, directory)) continue
    throw new Error(`Custom worktree is not isolated from protected checkout: ${protectedDirectory}`)
  }
}

function contains(parent: string, child: string) {
  const relative = path.relative(normalize(parent), normalize(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function normalize(value: string) {
  const result = path.normalize(value)
  return process.platform === "win32" ? result.toLowerCase() : result
}

async function same(left: string, right: string) {
  return normalize(await canonical(left)) === normalize(await canonical(right))
}

async function canonical(value: string) {
  const resolved = path.resolve(value)
  const fs = await import("node:fs/promises")
  try {
    return await fs.realpath(resolved)
  } catch {
    return resolved
  }
}

async function readMarker(file: string) {
  if (!(await Bun.file(file).exists())) return undefined
  try {
    const value = await Bun.file(file).json()
    if (
      value?.version !== 1 ||
      typeof value.base !== "string" ||
      typeof value.branch !== "string" ||
      typeof value.directory !== "string"
    )
      return undefined
    return value as { version: 1; base: string; branch: string; directory: string; created: number }
  } catch {
    return undefined
  }
}

async function stat(value: string, link = false) {
  const fs = await import("node:fs/promises")
  try {
    return link ? await fs.lstat(value) : await fs.stat(value)
  } catch {
    return undefined
  }
}

async function mkdir(directory: string) {
  const fs = await import("node:fs/promises")
  await fs.mkdir(directory, { recursive: true })
}

async function git(cwd: string, args: string[], signal?: AbortSignal) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", signal })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

async function shell(
  command: string,
  cwd: string,
  input: { timeout: number; stdin: string; env: Record<string, string> },
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeout)
  const proc = Bun.spawn(process.platform === "win32" ? ["cmd", "/c", command] : ["bash", "-lc", command], {
    cwd,
    env: { ...process.env, ...input.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    signal: controller.signal,
  })
  proc.stdin.write(input.stdin)
  proc.stdin.end()
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timeout)
  }
}

function bindingFile(sessionID: string) {
  return path.join(Global.Path.data, "worktree-session", `${sessionID}.json`)
}

async function writeBinding(binding: Binding) {
  await Bun.write(bindingFile(binding.sessionID), JSON.stringify(binding))
}

async function readBinding(sessionID: string): Promise<Binding | undefined> {
  const file = Bun.file(bindingFile(sessionID))
  if (!(await file.exists())) return undefined
  try {
    const value = await file.json()
    const binding = parseBinding(value)
    return binding?.sessionID === sessionID ? binding : undefined
  } catch {
    return undefined
  }
}

function parseBinding(value: unknown): Binding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (
    item.version !== 1 ||
    typeof item.sessionID !== "string" ||
    typeof item.name !== "string" ||
    typeof item.directory !== "string" ||
    typeof item.launchDirectory !== "string" ||
    typeof item.projectRoot !== "string" ||
    !Array.isArray(item.protectedDirectories) ||
    !item.protectedDirectories.every((entry) => typeof entry === "string") ||
    typeof item.base !== "string" ||
    (item.provenance !== "git" && item.provenance !== "hook") ||
    typeof item.timeCreated !== "number"
  )
    return undefined
  return item as Binding
}

async function readSessionBinding(sessionID: string) {
  const binding = await withDatabase((database) => {
    const row = database.query("select metadata from session where id = ?").get(sessionID) as
      | { metadata: string | null }
      | undefined
    if (!row?.metadata) return undefined
    try {
      const metadata = JSON.parse(row.metadata) as Record<string, unknown>
      return parseBinding(metadata[MetadataKey])
    } catch {
      return undefined
    }
  })
  if (binding) await writeBinding(binding)
  return binding
}

async function latestBinding(launchDirectory: string) {
  const fs = await import("node:fs/promises")
  const root = path.join(Global.Path.data, "worktree-session")
  const names = await fs.readdir(root).catch(() => [])
  const values = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => readBinding(name.slice(0, -5))),
  )
  const candidates = values
    .filter((item): item is Binding =>
      Boolean(
        item &&
          (normalize(item.launchDirectory) === normalize(launchDirectory) ||
            contains(item.projectRoot, launchDirectory)),
      ),
    )
    .toSorted((left, right) => right.timeCreated - left.timeCreated)
  if (!candidates.length) return undefined
  const ids = candidates.map((item) => item.sessionID)
  const latest = await withDatabase((database) => {
    const placeholders = ids.map(() => "?").join(",")
    const project = database
      .query(`select project_id from session where id in (${placeholders}) limit 1`)
      .get(...ids) as { project_id: string } | undefined
    if (!project) return undefined
    return (
      database
        .query(
          "select id from session where project_id = ? and parent_id is null and time_archived is null order by time_updated desc, id desc limit 1",
        )
        .get(project.project_id) as { id: string } | undefined
    )?.id
  })
  if (!latest) return candidates[0]
  return candidates.find((item) => item.sessionID === latest)
}

async function latestPersistedBinding(launchDirectory: string) {
  return withDatabase((database) => {
    const rows = database
      .query(
        "select directory, metadata from session where parent_id is null and time_archived is null order by time_updated desc, id desc limit 500",
      )
      .all() as Array<{ directory: string; metadata: string | null }>
    for (const row of rows) {
      const binding = (() => {
        if (!row.metadata) return undefined
        try {
          const metadata = JSON.parse(row.metadata) as Record<string, unknown>
          return parseBinding(metadata[MetadataKey])
        } catch {
          return undefined
        }
      })()
      if (
        binding &&
        (contains(binding.projectRoot, launchDirectory) || contains(launchDirectory, binding.projectRoot))
      ) {
        return { available: true, binding }
      }
      if (normalize(row.directory) === normalize(launchDirectory)) return { available: true, binding: undefined }
    }
    return { available: true, binding: undefined }
  })
}

async function removeBinding(sessionID: string) {
  const fs = await import("node:fs/promises")
  await fs.rm(bindingFile(sessionID), { force: true })
}

function lifecycleKey(directory: string) {
  return Bun.hash(normalize(directory)).toString(36)
}

function operationLock(directory: string) {
  return path.join(Global.Path.state, "worktree-lock", `${lifecycleKey(directory)}.lock`)
}

function ownerRoot(directory: string) {
  return path.join(Global.Path.state, "worktree-owner", lifecycleKey(directory))
}

async function registerOwner(binding: Binding) {
  const release = await acquireOperationLock(binding.directory)
  if (!release) throw new Error("Worktree lifecycle is busy in another process")
  const file = path.join(
    ownerRoot(binding.directory),
    `${binding.sessionID}-${process.pid}-${crypto.randomUUID().slice(0, 8)}.json`,
  )
  try {
    const fs = await import("node:fs/promises")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, JSON.stringify({ sessionID: binding.sessionID, pid: process.pid }))
    return file
  } finally {
    await release()
  }
}

async function hasActiveOwner(binding: Binding, current: string) {
  const fs = await import("node:fs/promises")
  const files = await fs.readdir(ownerRoot(binding.directory)).catch(() => [])
  for (const name of files) {
    const file = path.join(ownerRoot(binding.directory), name)
    if (file === current) continue
    try {
      const owner = (await Bun.file(file).json()) as { pid?: unknown }
      if (typeof owner.pid !== "number") continue
      process.kill(owner.pid, 0)
      return true
    } catch {
      await fs.rm(file, { force: true })
    }
  }
  return false
}

async function acquireOperationLock(directory: string): Promise<(() => Promise<void>) | undefined> {
  const fs = await import("node:fs/promises")
  const file = operationLock(directory)
  await fs.mkdir(path.dirname(file), { recursive: true })
  for (const attempt of [0, 1]) {
    try {
      await fs.mkdir(file)
      await Bun.write(path.join(file, "owner.json"), JSON.stringify({ pid: process.pid }))
      return () => fs.rm(file, { recursive: true, force: true })
    } catch {
      if (attempt > 0) return undefined
      try {
        const owner = (await Bun.file(path.join(file, "owner.json")).json()) as { pid?: unknown }
        if (typeof owner.pid === "number") process.kill(owner.pid, 0)
        return undefined
      } catch {
        await fs.rm(file, { recursive: true, force: true })
      }
    }
  }
  return undefined
}

export async function markSessionName(sessionID: string, title: string) {
  const binding = await readBinding(sessionID)
  if (!binding) return
  await writeBinding({ ...binding, sessionName: title })
}

export async function adoptSessionBinding(value: unknown) {
  const binding = parseBinding(value)
  if (!binding) return { status: "none" as const }
  const status = await verify(binding)
  if (status === "gone" || status === "unsafe") {
    await removeBinding(binding.sessionID)
    await moveSessionRecord(binding.sessionID, binding.launchDirectory)
  }
  if (status !== "valid") return { status, binding }
  const ownerFile = await registerOwner(binding)
  return {
    status,
    binding,
    release: async () => {
      const fs = await import("node:fs/promises")
      await fs.rm(ownerFile, { force: true })
    },
  }
}

async function moveSessionRecord(sessionID: string, directory: string) {
  await withDatabase((database) => {
    database.query("update session set directory = ?, path = null where id = ?").run(directory, sessionID)
  }, false)
}

async function withDatabase<A>(
  fn: (database: import("bun:sqlite").Database) => A,
  readonly = true,
): Promise<A | undefined> {
  try {
    const module = await import("@opencode-ai/core/database/database")
    const filename = module.Database.path()
    if (filename === ":memory:") return undefined
    const sqlite = await import("bun:sqlite")
    const database = new sqlite.Database(filename, { readonly })
    try {
      return fn(database)
    } finally {
      database.close()
    }
  } catch {
    return undefined
  }
}
