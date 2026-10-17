import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { afterEach, describe, expect, it, vi } from "vitest"
import { workspaceChatDockerImage } from "../workspaces/chat-runtime.js"
import {
  INGEST_AGENT_USER,
  stopIngestAgentProcesses,
} from "./ingest-prepare.js"
import { dockerRootExec, runAsRoot } from "./ingest-root.js"
import { INGEST_STEP_LIMIT_MS, ingestStepSignal } from "./ingest-shard-ops.js"

/*
 * Contract (Docker): a hung step ends at the step limit, and its processes
 * are gone before the exec returns. Only `setTimeout` is fake: the step
 * limit timer. Docker I/O uses Node's internal timers.
 */

afterEach(() => {
  vi.useRealTimers()
})

describe("dockerRootExec with a step limit", () => {
  it(
    "ends the whole process group of a hung agent command at the limit",
    { timeout: 180_000 },
    async () => {
      const provider = dockerSandbox({ image: workspaceChatDockerImage() })
      const handle = await provider.create({
        id: `ingest-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })
      try {
        const root = dockerRootExec(handle.id)
        const count = async () =>
          Number(
            (
              await root("ps -eo args | grep -c '^sleep 86[4]00' || true")
            ).stdout.trim(),
          )
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
        const signal = ingestStepSignal()
        // An agent command with a child in the background, as `opencode run`
        // starts its own children.
        const hung = root(
          "runuser -u node -- sh -c 'sleep 86400 & sleep 86400'",
          { signal },
        )
        const outcome = hung.then(
          () => "finished",
          (error: Error) => error.message,
        )
        while ((await count()) < 2) {}
        vi.advanceTimersByTime(INGEST_STEP_LIMIT_MS - 1)
        expect(signal.aborted).toBe(false)
        vi.advanceTimersByTime(1)
        expect(await outcome).toBe("The ingest step reached its time limit")
        expect(await count()).toBe(0)
      } finally {
        vi.useRealTimers()
        await provider.destroy({ id: handle.id })
      }
    },
  )

  it(
    "an abort stops an agent process that left the step's process group before the exec rejects",
    { timeout: 180_000 },
    async () => {
      const provider = dockerSandbox({ image: workspaceChatDockerImage() })
      const handle = await provider.create({
        id: `ingest-abort-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })
      try {
        const root = dockerRootExec(handle.id)
        await runAsRoot(
          root,
          `useradd --system --user-group --no-create-home --shell /bin/sh ${INGEST_AGENT_USER} && mkdir -m 777 /tmp/abort-probe`,
        )
        const count = async () =>
          Number(
            (
              await root(
                `ps -u ${INGEST_AGENT_USER} -o args= | grep -c '^sleep 86[4]02' || true`,
              )
            ).stdout.trim(),
          )
        const controller = new AbortController()
        // The step starts a child in a new session (out of the step's
        // process group), then the child writes the ready file.
        const running = root(
          `runuser -u ${INGEST_AGENT_USER} -- sh -c 'setsid sh -c "touch /tmp/abort-probe/ready; exec sleep 86402" </dev/null >/dev/null 2>&1 & wait'`,
          { signal: controller.signal },
        )
        const outcome = running.then(
          () => "finished",
          (error: Error) => error.message,
        )
        // Wait for the readiness signal: the ready file and the process.
        while (
          (await root("test -f /tmp/abort-probe/ready")).exitCode !== 0 ||
          (await count()) < 1
        ) {}
        controller.abort(new Error("step aborted"))
        expect(await outcome).toBe("step aborted")
        expect(await count()).toBe(0)
        const left = await root(`pgrep -u ${INGEST_AGENT_USER} || true`)
        expect(left.stdout.trim()).toBe("")
      } finally {
        await provider.destroy({ id: handle.id })
      }
    },
  )

  it(
    "stops a detached agent process of the last step before the next step starts",
    { timeout: 180_000 },
    async () => {
      const provider = dockerSandbox({ image: workspaceChatDockerImage() })
      const handle = await provider.create({
        id: `ingest-stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })
      try {
        const root = dockerRootExec(handle.id)
        // No agent user yet: there is nothing to stop.
        await stopIngestAgentProcesses(root)
        await runAsRoot(
          root,
          `useradd --system --user-group --no-create-home --shell /bin/sh ${INGEST_AGENT_USER}`,
        )
        const count = async () =>
          Number(
            (
              await root(
                `ps -u ${INGEST_AGENT_USER} -o args= | grep -c '^sleep 86[4]01' || true`,
              )
            ).stdout.trim(),
          )
        // The last step: one process leaves its group with setsid, one with a
        // double fork. The exec returns while both live.
        const step = await root(
          `runuser -u ${INGEST_AGENT_USER} -- sh -c 'setsid sleep 86401 </dev/null >/dev/null 2>&1 & (sh -c "sleep 86401 </dev/null >/dev/null 2>&1 &") ; exit 0'`,
        )
        expect(step.exitCode, step.stderr).toBe(0)
        while ((await count()) < 2) {}

        await stopIngestAgentProcesses(root)
        expect(await count()).toBe(0)
        const left = await root(`pgrep -u ${INGEST_AGENT_USER} || true`)
        expect(left.stdout.trim()).toBe("")
      } finally {
        await provider.destroy({ id: handle.id })
      }
    },
  )
})
