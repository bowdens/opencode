import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { assertPath } from "@/tool/worktree-isolation"
import { MessageID, SessionID } from "@/session/schema"

describe("worktree isolation", () => {
  test("allows the active nested worktree and rejects its protected checkout", async () => {
    await using tmp = await tmpdir()
    const worktree = path.join(tmp.path, ".claude", "worktrees", "feature")
    await fs.mkdir(worktree, { recursive: true })
    const ctx = {
      sessionID: SessionID.make("ses_worktree-isolation"),
      messageID: MessageID.make("msg_worktree-isolation"),
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
      extra: {
        worktree: {
          directory: worktree,
          protectedDirectories: [tmp.path],
        },
      },
    }

    await expect(Effect.runPromise(assertPath(ctx, path.join(worktree, "safe.txt")))).resolves.toBeUndefined()
    await expect(Effect.runPromise(assertPath(ctx, path.join(tmp.path, "protected.txt")))).rejects.toThrow(
      "Worktree isolation prevents access to the protected checkout",
    )
  })

  test("rejects a symlink from the active worktree into the protected checkout", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir()
    const worktree = path.join(tmp.path, ".claude", "worktrees", "feature")
    const protectedDirectory = path.join(tmp.path, "source")
    await fs.mkdir(worktree, { recursive: true })
    await fs.mkdir(protectedDirectory)
    await fs.symlink(protectedDirectory, path.join(worktree, "escape"))
    await fs.symlink(path.join(protectedDirectory, "missing.txt"), path.join(worktree, "dangling"))
    const ctx = {
      sessionID: SessionID.make("ses_worktree-symlink"),
      messageID: MessageID.make("msg_worktree-symlink"),
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
      extra: {
        worktree: {
          directory: worktree,
          protectedDirectories: [tmp.path],
        },
      },
    }

    for (const target of [
      path.join(worktree, "escape", "file.txt"),
      path.join(worktree, "escape", "new-directory", "file.txt"),
      path.join(worktree, "dangling"),
    ]) {
      await expect(Effect.runPromise(assertPath(ctx, target))).rejects.toThrow(
        "Worktree isolation prevents access to the protected checkout",
      )
    }
  })
})
