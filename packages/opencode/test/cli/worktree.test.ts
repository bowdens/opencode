import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt, testModelID } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { tmpdir } from "../fixture/fixture"
import { adoptSessionBinding, type Binding } from "@/cli/worktree"

async function git(directory: string, ...args: string[]) {
  await $`git ${args}`.cwd(directory).quiet()
}

async function initialise(directory: string) {
  await git(directory, "init")
  await git(directory, "config", "core.fsmonitor", "false")
  await git(directory, "config", "commit.gpgsign", "false")
  await git(directory, "config", "user.email", "test@opencode.test")
  await git(directory, "config", "user.name", "Test")
  await git(directory, "commit", "--allow-empty", "-m", "root")
}

describe("worktree CLI", () => {
  test("serializes concurrent server ownership registration", async () => {
    await using directory = await tmpdir()
    await using protectedDirectory = await tmpdir()
    const binding: Binding = {
      version: 1,
      sessionID: "ses_concurrent-adoption",
      name: "concurrent-adoption",
      directory: directory.path,
      launchDirectory: protectedDirectory.path,
      projectRoot: protectedDirectory.path,
      protectedDirectories: [protectedDirectory.path],
      base: "hook",
      provenance: "hook",
      timeCreated: Date.now(),
    }

    const results = await Promise.all(Array.from({ length: 4 }, () => adoptSessionBinding(binding)))
    expect(results.every((result) => result.status === "valid")).toBe(true)
    await Promise.all(results.flatMap((result) => (result.status === "valid" ? [result.release()] : [])))
  })

  cliIt.live(
    "creates and retains a named Git worktree before a non-interactive prompt",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => initialise(home))
        yield* llm.text("created in worktree")

        const result = yield* opencode.spawn([
          "run",
          "--model",
          testModelID,
          "--worktree",
          "feature-auth",
          "--prompt",
          "say where you are",
        ])

        opencode.expectExit(result, 0)
        expect(result.stdout).toBe("created in worktree\n")
        const directory = path.join(home, ".claude", "worktrees", "feature-auth")
        expect(yield* Effect.promise(() => Bun.file(path.join(directory, ".git")).exists())).toBe(true)
        expect(yield* Effect.promise(() => $`git branch --show-current`.cwd(directory).quiet().text())).toBe(
          "worktree-feature-auth\n",
        )
      }),
    60_000,
  )

  cliIt.live(
    "copies matching ignored files through .worktreeinclude",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await initialise(home)
          await Bun.write(path.join(home, ".gitignore"), ".env\n.claude/worktrees/\n")
          await Bun.write(path.join(home, ".worktreeinclude"), ".env\n")
          await Bun.write(path.join(home, ".env"), "WORKTREE_SECRET=test\n")
          await git(home, "add", ".gitignore", ".worktreeinclude")
          await git(home, "commit", "-m", "worktree setup")
        })
        yield* llm.text("copied")

        const result = yield* opencode.spawn([
          "run",
          "--model",
          testModelID,
          "-w",
          "include-test",
          "--prompt",
          "check setup",
        ])

        opencode.expectExit(result, 0)
        expect(
          yield* Effect.promise(() => Bun.file(path.join(home, ".claude", "worktrees", "include-test", ".env")).text()),
        ).toBe("WORKTREE_SECRET=test\n")
      }),
    60_000,
  )

  cliIt.live(
    "uses a WorktreeCreate hook outside Git and reserves its session ID",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const script = path.join(home, "create-worktree.ts")
        const directory = path.join(path.dirname(home), `${path.basename(home)}-custom-worktree`)
        const captured = path.join(home, "hook-input.json")
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            const fs = await import("node:fs/promises")
            await fs.rm(directory, { recursive: true, force: true })
          }).pipe(Effect.ignore),
        )
        yield* Effect.promise(async () => {
          await Bun.write(
            script,
            [
              'import fs from "node:fs/promises"',
              `const input = await Bun.stdin.text()`,
              `await fs.mkdir(${JSON.stringify(directory)}, { recursive: true })`,
              `await Bun.write(${JSON.stringify(captured)}, input)`,
              `console.log(${JSON.stringify(directory)})`,
            ].join("\n"),
          )
          await Bun.write(
            path.join(home, ".claude", "settings.local.json"),
            JSON.stringify({
              hooks: {
                WorktreeCreate: [{ hooks: [{ type: "command", command: `bun ${JSON.stringify(script)}` }] }],
              },
            }),
          )
        })
        yield* llm.text("hooked")

        const result = yield* opencode.spawn([
          "run",
          "--model",
          testModelID,
          "-w",
          "custom-name",
          "--dangerously-skip-permissions",
          "--prompt",
          "run hook",
        ])

        opencode.expectExit(result, 0)
        const input = yield* Effect.promise(() => Bun.file(captured).json())
        const fs = yield* Effect.promise(() => import("node:fs/promises"))
        expect(input).toMatchObject({
          hook_event_name: "WorktreeCreate",
          cwd: yield* Effect.promise(() => fs.realpath(home)),
          name: "custom-name",
        })
        const records = yield* Effect.promise(async () => {
          const root = path.join(home, ".local", "share", "opencode", "worktree-session")
          return Promise.all((await fs.readdir(root)).map((name) => Bun.file(path.join(root, name)).json()))
        })
        expect(records).toContainEqual(
          expect.objectContaining({
            sessionID: input.session_id,
            directory: yield* Effect.promise(() => fs.realpath(directory)),
          }),
        )
      }),
    60_000,
  )

  cliIt.live(
    "resumes a retained session inside its worktree without passing -w again",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => initialise(home))
        yield* llm.text("first run")
        const first = yield* opencode.spawn(
          ["run", "--model", testModelID, "--format", "json", "-w", "resume-test", "--prompt", "start"],
          { env: { OPENCODE_DB: "opencode.db" } },
        )
        opencode.expectExit(first, 0)
        const sessionID = opencode.parseJsonEvents(first.stdout)[0]?.sessionID
        expect(typeof sessionID).toBe("string")
        expect(
          yield* Effect.promise(() =>
            Bun.file(
              path.join(home, ".local", "share", "opencode", "worktree-session", `${String(sessionID)}.json`),
            ).exists(),
          ),
        ).toBe(true)
        yield* Effect.promise(async () => {
          const fs = await import("node:fs/promises")
          await fs.rm(path.join(home, ".local", "share", "opencode", "worktree-session", `${String(sessionID)}.json`))
        })

        yield* llm.push(
          reply().tool("bash", {
            command: "pwd > resumed.txt",
            description: "Record the current directory",
          }),
        )
        yield* llm.text("resumed")
        const resumed = yield* opencode.spawn(
          ["run", "--model", testModelID, "--session", String(sessionID), "--dangerously-skip-permissions", "continue"],
          { env: { OPENCODE_DB: "opencode.db" } },
        )

        opencode.expectExit(resumed, 0)
        const directory = path.join(home, ".claude", "worktrees", "resume-test")
        expect((yield* Effect.promise(() => Bun.file(path.join(directory, "resumed.txt")).text())).trim()).toBe(
          yield* Effect.promise(async () => {
            const fs = await import("node:fs/promises")
            return fs.realpath(directory)
          }),
        )
      }),
    60_000,
  )

  cliIt.live(
    "blocks shell writes into the protected checkout",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => initialise(home))
        const blocked = path.join(home, "blocked.txt")
        yield* llm.push(
          reply().tool("bash", {
            command: `echo blocked > ${JSON.stringify(blocked)}`,
            description: "Attempt to write outside the worktree",
          }),
        )
        yield* llm.text("blocked")

        const result = yield* opencode.spawn([
          "run",
          "--model",
          testModelID,
          "-w",
          "isolation-test",
          "--dangerously-skip-permissions",
          "--prompt",
          "try protected write",
        ])

        opencode.expectExit(result, 0)
        expect(yield* Effect.promise(() => Bun.file(blocked).exists())).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "clears a missing worktree binding and resumes in the launch checkout",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => initialise(home))
        yield* llm.text("created")
        const first = yield* opencode.spawn(
          ["run", "--model", testModelID, "--format", "json", "-w", "gone-test", "--prompt", "start"],
          { env: { OPENCODE_DB: "opencode.db" } },
        )
        opencode.expectExit(first, 0)
        const sessionID = String(opencode.parseJsonEvents(first.stdout)[0]?.sessionID)
        const directory = path.join(home, ".claude", "worktrees", "gone-test")
        yield* Effect.promise(() => $`git worktree remove --force ${directory}`.cwd(home).quiet())

        yield* llm.push(
          reply().tool("bash", {
            command: `pwd > ${JSON.stringify(path.join(home, "recovered.txt"))}`,
            description: "Record recovery directory",
          }),
        )
        yield* llm.text("recovered")
        const resumed = yield* opencode.spawn(
          ["run", "--model", testModelID, "--session", sessionID, "--dangerously-skip-permissions", "continue"],
          { env: { OPENCODE_DB: "opencode.db" } },
        )

        opencode.expectExit(resumed, 0)
        expect(resumed.stderr).toContain("is unavailable")
        expect((yield* Effect.promise(() => Bun.file(path.join(home, "recovered.txt")).text())).trim()).toBe(
          yield* Effect.promise(async () => {
            const fs = await import("node:fs/promises")
            return fs.realpath(home)
          }),
        )
      }),
    60_000,
  )

  cliIt.live(
    "blocks obfuscated protected checkout paths",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => initialise(home))
        const blocked = path.join(home, "blocked.txt")
        const obfuscated = blocked.replace(
          path.basename(home),
          `${path.basename(home).slice(0, -1)}""${path.basename(home).at(-1)}`,
        )
        yield* llm.push(
          reply().tool("bash", {
            command: `touch ${obfuscated}`,
            description: "Attempt an obfuscated protected write",
          }),
        )
        yield* llm.text("blocked")

        const result = yield* opencode.spawn([
          "run",
          "--model",
          testModelID,
          "-w",
          "obfuscated-isolation",
          "--dangerously-skip-permissions",
          "--prompt",
          "try obfuscated write",
        ])

        opencode.expectExit(result, 0)
        expect(yield* Effect.promise(() => Bun.file(blocked).exists())).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "fails before model execution when a create hook exits non-zero",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Bun.write(
            path.join(home, ".claude", "settings.local.json"),
            JSON.stringify({
              hooks: {
                WorktreeCreate: [{ hooks: [{ type: "command", command: "echo setup-failed >&2; exit 7" }] }],
              },
            }),
          ),
        )

        const result = yield* opencode.spawn([
          "run",
          "-w",
          "hook-failure",
          "--dangerously-skip-permissions",
          "--prompt",
          "must not run",
        ])

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("setup-failed")
      }),
    30_000,
  )

  cliIt.live(
    "rejects multiple create hooks before running either command",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const first = path.join(home, "first-ran")
        const second = path.join(home, "second-ran")
        yield* Effect.promise(() =>
          Bun.write(
            path.join(home, ".claude", "settings.local.json"),
            JSON.stringify({
              hooks: {
                WorktreeCreate: [
                  [{ type: "command", command: `touch ${JSON.stringify(first)}` }],
                  [{ type: "command", command: `touch ${JSON.stringify(second)}` }],
                ].map((hooks) => ({ hooks })),
              },
            }),
          ),
        )

        const result = yield* opencode.spawn([
          "run",
          "-w",
          "multiple-hooks",
          "--dangerously-skip-permissions",
          "--prompt",
          "must not run",
        ])

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Multiple WorktreeCreate")
        expect(yield* Effect.promise(() => Bun.file(first).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(second).exists())).toBe(false)
      }),
    30_000,
  )

  cliIt.live(
    "rejects a custom hook path inside the protected checkout",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const source = path.join(home, "source")
        yield* Effect.promise(async () => {
          const fs = await import("node:fs/promises")
          await fs.mkdir(source)
          await Bun.write(
            path.join(home, ".claude", "settings.local.json"),
            JSON.stringify({
              hooks: {
                WorktreeCreate: [{ hooks: [{ type: "command", command: `echo ${JSON.stringify(source)}` }] }],
              },
            }),
          )
        })

        const result = yield* opencode.spawn([
          "run",
          "-w",
          "unsafe-hook",
          "--dangerously-skip-permissions",
          "--prompt",
          "must not run",
        ])

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Custom worktree is not isolated")
      }),
    30_000,
  )

  cliIt.live(
    "preserves the original cleanup base when reopening a worktree with commits",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => initialise(home))
        yield* llm.text("created")
        const first = yield* opencode.spawn(["run", "--model", testModelID, "-w", "reuse-test", "--prompt", "create"])
        opencode.expectExit(first, 0)
        const directory = path.join(home, ".claude", "worktrees", "reuse-test")
        const originalBase = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(directory).quiet().text())).trim()
        yield* Effect.promise(async () => {
          await Bun.write(path.join(directory, "work.txt"), "retained\n")
          await git(directory, "add", "work.txt")
          await git(directory, "commit", "-m", "retained work")
        })

        yield* llm.text("reopened")
        const second = yield* opencode.spawn(["run", "--model", testModelID, "-w", "reuse-test", "--prompt", "reopen"])
        opencode.expectExit(second, 0)
        const records = yield* Effect.promise(async () => {
          const fs = await import("node:fs/promises")
          const root = path.join(home, ".local", "share", "opencode", "worktree-session")
          return Promise.all((await fs.readdir(root)).map((name) => Bun.file(path.join(root, name)).json()))
        })
        const latest = records.toSorted((left, right) => right.timeCreated - left.timeCreated)[0]
        expect(latest.base).toBe(originalBase)
        expect(latest.branch).toBe("worktree-reuse-test")
      }),
    60_000,
  )
})
