import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { describe, expect, it } from "vitest"
import {
  classifySandboxCommand,
  parseSandboxLifecycleMarks,
  timedSandboxHandle,
  wrapSandboxSetupCommand,
} from "./sandbox-lifecycle-timing.js"

describe("sandbox lifecycle timing", () => {
  it("names the bootstrap and resume commands we actually run", () => {
    expect(classifySandboxCommand("git cat-file -e 'abc^{commit}'")).toBe(
      "git-cat-file",
    )
    expect(classifySandboxCommand("git checkout --detach 'abc'")).toBe(
      "git-checkout-detach",
    )
    expect(classifySandboxCommand("git rev-parse HEAD")).toBe(
      "git-rev-parse-head",
    )
    expect(
      classifySandboxCommand(
        "command -v opencode >/dev/null 2>&1 || npm install -g opencode-ai",
      ),
    ).toBe("setup-opencode")
    expect(
      classifySandboxCommand("opencode serve --hostname=127.0.0.1 --port=4096"),
    ).toBe("opencode-serve")
  })

  it("wraps a setup command so the bootstrap shell sees the real exit code", () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-lifecycle-"))
    const mark = join(dir, "marks.jsonl")
    const wrapped = wrapSandboxSetupCommand(
      "setup-opencode",
      "printf ready; (exit 3)",
    ).replace("/tmp/ctxpipe-sandbox-lifecycle.jsonl", mark)
    const out = execFileSync(
      "sh",
      ["-c", `{ ${wrapped} ; } 2>&1; printf "\\n__BSSH_0__ $?\\n"`],
      { encoding: "utf8" },
    )
    expect(out).toMatch(/__BSSH_0__ 3/)
    const marks = parseSandboxLifecycleMarks(readFileSync(mark, "utf8"))
    expect(marks).toEqual([
      expect.objectContaining({ phase: "setup-opencode" }),
    ])
    expect(marks[0]?.ms).toBeGreaterThanOrEqual(0)
  })

  it("keeps Docker class-method snapshot and destroy after timing wrap", async () => {
    class DockerStyleHandle {
      id = "ctr"
      async snapshot(label?: string) {
        return { id: `snap-${label ?? "default"}` }
      }
      async destroy() {
        return undefined
      }
    }
    const timed = timedSandboxHandle(
      new DockerStyleHandle() as unknown as SandboxHandle,
    )
    expect(typeof timed.snapshot).toBe("function")
    expect(typeof timed.destroy).toBe("function")
    await expect(timed.snapshot?.("after-setup")).resolves.toEqual({
      id: "snap-after-setup",
    })
    await expect(timed.destroy()).resolves.toBeUndefined()
  })

  describe("kill", () => {
    // A real child that ignores SIGTERM. It prints "up" once the trap is set.
    function handleWithRealProcess(signals: Array<string | undefined>) {
      const process = {
        spawn: async (command: string) => {
          const child = spawn("sh", ["-c", command], { stdio: "pipe" })
          const exited = new Promise<void>((resolve) =>
            child.once("exit", () => resolve()),
          )
          const up = new Promise<void>((resolve) =>
            child.stdout.once("data", () => resolve()),
          )
          return {
            pid: child.pid,
            up,
            wait: () => exited,
            kill: async (signal?: NodeJS.Signals) => {
              signals.push(signal)
              child.kill(signal ?? "SIGTERM")
            },
          }
        },
      }
      return timedSandboxHandle({ process } as unknown as SandboxHandle)
    }

    it("passes an explicit signal on and does not escalate", async () => {
      const signals: Array<string | undefined> = []
      const handle = handleWithRealProcess(signals)
      const proc = (await handle.process.spawn(
        "trap '' TERM; echo up; sleep 30",
      )) as Awaited<ReturnType<typeof handle.process.spawn>> & {
        up: Promise<void>
      }
      await proc.up
      await proc.kill("SIGTERM")
      await new Promise((resolve) => setTimeout(resolve, 700))
      expect(signals).toEqual(["SIGTERM"])
      await proc.kill("SIGKILL")
      await proc.wait()
    })

    it("escalates to SIGKILL after 500 ms when no signal is given", async () => {
      const signals: Array<string | undefined> = []
      const handle = handleWithRealProcess(signals)
      const proc = (await handle.process.spawn(
        "trap '' TERM; echo up; while :; do sleep 1; done",
      )) as Awaited<ReturnType<typeof handle.process.spawn>> & {
        up: Promise<void>
      }
      await proc.up
      const started = Date.now()
      await proc.kill()
      expect(Date.now() - started).toBeGreaterThanOrEqual(450)
      expect(signals).toEqual([undefined, "SIGKILL"])
    })
  })
})
