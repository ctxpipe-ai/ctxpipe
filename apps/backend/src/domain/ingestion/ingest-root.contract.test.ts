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

  it(
    "waits for a root command that writes no output for more than two minutes",
    { timeout: 240_000 },
    async () => {
      // A model step sends `opencode run` through `grep`, so the exec can
      // write nothing for minutes. A Docker client timeout of 120 s ended
      // each model step of the CTX-630 proof runs after 120 s.
      const provider = dockerSandbox({ image: "alpine:3.22" })
      const handle = await provider.create({
        id: `ingest-silent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })
      try {
        const result = await dockerRootExec(handle.id)("sleep 125; echo done")
        expect(result).toMatchObject({ exitCode: 0, stdout: "done\n" })
      } finally {
        await provider.destroy({ id: handle.id })
      }
    },
  )

  it(
    "does not count a zombie of the agent user whose parent never reaps it",
    { timeout: 180_000 },
    async () => {
      const provider = dockerSandbox({ image: workspaceChatDockerImage() })
      const handle = await provider.create({
        id: `ingest-zombie-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })
      try {
        const root = dockerRootExec(handle.id)
        await runAsRoot(
          root,
          `useradd --system --user-group --no-create-home --shell /bin/sh ${INGEST_AGENT_USER}`,
        )
        // A root process that never reaps starts a child of the agent user.
        // The child exits at once and stays a zombie, as an orphan does when
        // PID 1 does not reap it. The stop cannot kill a zombie.
        const start = await root(
          `(sh -c 'setpriv --reuid=${INGEST_AGENT_USER} --regid=${INGEST_AGENT_USER} --clear-groups true & exec sleep 86404' </dev/null >/dev/null 2>&1 &)`,
        )
        expect(start.exitCode, start.stderr).toBe(0)
        const zombies = async () =>
          Number(
            (
              await root(
                `ps -u ${INGEST_AGENT_USER} -o stat= | grep -c '^Z' || true`,
              )
            ).stdout.trim(),
          )
        while ((await zombies()) < 1) {}
        // It fails with "Agent processes are left" if it counts the zombie.
        await stopIngestAgentProcesses(root)
        expect(await zombies()).toBe(1)
      } finally {
        await provider.destroy({ id: handle.id })
      }
    },
  )
})
