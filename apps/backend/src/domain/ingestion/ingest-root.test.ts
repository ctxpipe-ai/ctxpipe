import { describe, expect, it } from "vitest"
import { ingestAgentCommand } from "./ingest-opencode.js"
import { assertIngestProvider } from "./ingest-prepare.js"
import { runAsRoot, vercelRootExec } from "./ingest-root.js"

/*
 * The hosted path runs the same root scripts as Docker, through the Vercel
 * SDK's `sudo` option. The Docker contract test runs those scripts for real,
 * also in an image whose default user has passwordless sudo as on Vercel;
 * this test proves the Vercel call. No Vercel sandbox runs here (T12).
 */

type Call = { cmd: string; args?: string[]; sudo?: boolean }

function fakeSandbox(exitCode: number, stderr = "") {
  const calls: Call[] = []
  return {
    calls,
    sandbox: {
      runCommand: async (input: Call) => {
        calls.push(input)
        return {
          exitCode,
          output: async (stream: "stdout" | "stderr") =>
            stream === "stderr" ? stderr : "out",
        }
      },
    },
  }
}

describe("vercelRootExec", () => {
  it("runs the script with sudo through sh", async () => {
    const { calls, sandbox } = fakeSandbox(0)
    expect(await vercelRootExec(sandbox)("mkdir -p /ctxpipe")).toEqual({
      stdout: "out",
      stderr: "",
      exitCode: 0,
    })
    expect(calls).toEqual([
      { cmd: "sh", args: ["-c", "mkdir -p /ctxpipe"], sudo: true },
    ])
  })

  it("runs a signalled script in its own process group, and an abort ends the group as root before the call rejects", async () => {
    const calls: Call[] = []
    let finishStep: (() => void) | undefined
    const sandbox = {
      runCommand: async (input: Call) => {
        calls.push(input)
        // The step runs until the kill command ends its group.
        if (input.cmd === "setsid")
          await new Promise<void>((resolve) => {
            finishStep = resolve
          })
        else finishStep?.()
        return { exitCode: 0, output: async () => "" }
      },
    }
    const controller = new AbortController()
    const running = vercelRootExec(sandbox)("opencode run x", {
      signal: controller.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort(new Error("step limit"))
    await expect(running).rejects.toThrow("step limit")
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ cmd: "setsid", sudo: true })
    expect(calls[0]?.args?.slice(0, 3)).toEqual(["-w", "sh", "-c"])
    expect(calls[0]?.args?.at(-1)).toBe("opencode run x")
    expect(calls[1]).toMatchObject({ cmd: "sh", sudo: true })
    expect(calls[1]?.args?.[1]).toContain("kill -TERM -$g")
    // The group of each process comes from /proc: a Vercel sandbox has no `ps`.
    expect(calls[1]?.args?.[1]).not.toContain("ps -eo")
  })

  it("throws with the stderr when a root script fails", async () => {
    const { sandbox } = fakeSandbox(1, "sudo: not allowed")
    await expect(runAsRoot(vercelRootExec(sandbox), "true")).rejects.toThrow(
      /exit 1.*sudo: not allowed/,
    )
  })
})

describe("assertIngestProvider", () => {
  it("accepts Docker and Vercel", () => {
    expect(() => assertIngestProvider("docker")).not.toThrow()
    expect(() => assertIngestProvider("vercel")).not.toThrow()
  })

  it("refuses ingest in unsandboxed mode", () => {
    expect(() => assertIngestProvider("local-process")).toThrow(
      /needs a Docker or Vercel sandbox/,
    )
  })
})

describe("ingestAgentCommand", () => {
  it("runs the command as the agent user with only the given env", () => {
    expect(
      ingestAgentCommand({
        env: { HOME: "/ctxpipe/home" },
        command: "opencode --version",
      }),
    ).toBe(
      "runuser -u ctxpipe-agent -- env -i 'HOME=/ctxpipe/home' sh -c 'cd /ctxpipe/out && opencode --version'",
    )
  })
})
