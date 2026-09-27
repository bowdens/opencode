import type { Context } from "./tool"
import path from "node:path"
import { Effect } from "effect"

type Binding = {
  directory: string
  protectedDirectories: string[]
}

export function active(ctx: Context) {
  return parse(ctx.extra?.worktree) !== undefined
}

export const assertCommand = Effect.fnUntraced(function* (ctx: Context, command: string) {
  const binding = parse(ctx.extra?.worktree)
  if (!binding) return
  const withoutWorktree = command
    .replaceAll(binding.directory, "")
    .replaceAll(binding.directory.replaceAll("\\", "/"), "")
  for (const protectedDirectory of binding.protectedDirectories) {
    if (
      !withoutWorktree.includes(protectedDirectory) &&
      !withoutWorktree.includes(protectedDirectory.replaceAll("\\", "/"))
    )
      continue
    throw new Error(
      `Worktree isolation prevents shell access to the protected checkout at ${protectedDirectory}. Use the active worktree at ${binding.directory}.`,
    )
  }
})

export const assertPath = Effect.fnUntraced(function* (ctx: Context, target: string | undefined) {
  if (!target) return
  const binding = parse(ctx.extra?.worktree)
  if (!binding) return

  const lexical = normalize(path.resolve(target))
  const real = yield* Effect.promise(() => canonical(lexical))
  if (contains(binding.directory, lexical) && contains(binding.directory, real)) return
  for (const protectedDirectory of binding.protectedDirectories) {
    if (!contains(protectedDirectory, lexical) && !contains(protectedDirectory, real)) continue
    throw new Error(
      `Worktree isolation prevents access to the protected checkout at ${protectedDirectory}. Use the active worktree at ${binding.directory}.`,
    )
  }
})

export const assertPaths = Effect.fnUntraced(function* (ctx: Context, targets: Iterable<string | undefined>) {
  for (const target of targets) yield* assertPath(ctx, target)
})

function parse(value: unknown): Binding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const item = value as Record<string, unknown>
  if (typeof item.directory !== "string" || !Array.isArray(item.protectedDirectories)) return
  if (!item.protectedDirectories.every((entry) => typeof entry === "string")) return
  return { directory: item.directory, protectedDirectories: item.protectedDirectories as string[] }
}

function contains(parent: string, child: string) {
  const relative = path.relative(normalize(parent), normalize(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function normalize(value: string) {
  const result = path.normalize(value)
  return process.platform === "win32" ? result.toLowerCase() : result
}

async function canonical(value: string, depth = 0): Promise<string> {
  if (depth > 40) throw new Error("Too many symbolic links while checking worktree isolation")
  const fs = await import("node:fs/promises")
  const absolute = path.resolve(value)
  const root = path.parse(absolute).root
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean)
  let current = root
  for (let index = 0; index < parts.length; index++) {
    const candidate = path.join(current, parts[index])
    const info = await fs.lstat(candidate).catch(() => undefined)
    if (!info) {
      current = candidate
      continue
    }
    if (!info.isSymbolicLink()) {
      current = candidate
      continue
    }
    return canonical(
      path.resolve(path.dirname(candidate), await fs.readlink(candidate), ...parts.slice(index + 1)),
      depth + 1,
    )
  }
  return current
}
