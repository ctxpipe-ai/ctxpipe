import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { expect, it } from "vitest"
import { workspaceChatDockerImage } from "./chat-runtime.js"
import { stopEarlierTurnProcesses } from "./sandbox-process-guards.js"

it(
  "stops every agent process of an earlier turn, also one in its own session, and keeps the sandbox",
  { timeout: 120_000 },
  async () => {
    let handle: SandboxHandle | undefined
    try {
      handle = await dockerSandbox({
        image: workspaceChatDockerImage(),
      }).create({ workspace: { source: { type: "none" } } })
      // Turn 1: the agent leaves processes that outlive its server, one of
      // them in a new session and process group.
      const started = await handle.process.exec(
        "setsid nohup sleep 1001 >/dev/null 2>&1 & nohup sleep 1002 >/dev/null 2>&1 & sleep 0.2; pgrep -x sleep | wc -l",
      )
      expect(started.stdout.trim()).toBe("2")
      // Turn 2 starts.
      await stopEarlierTurnProcesses(handle)
      const left = await handle.process.exec(
        "pgrep -x sleep | wc -l; cat /proc/1/cmdline | tr '\\0' ' '",
      )
      expect(left.exitCode).toBe(0)
      const [count, init] = left.stdout.trim().split("\n")
      expect(count?.trim()).toBe("0")
      // The sandbox's own process (PID 1) still runs.
      expect(init).toContain("tail -f /dev/null")
    } finally {
      await handle?.destroy().catch(() => undefined)
    }
  },
)
