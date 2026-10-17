import { describe, expect, it } from "vitest"
import { ingestAgentCommand } from "./ingest-opencode.js"
import { assertIngestProvider } from "./ingest-prepare.js"
import { runAsRoot, vercelRootExec } from "./ingest-root.js"

/*
 * The hosted path runs the same root scripts as Docker, through the Vercel
 * SDK's `sudo` option. The Docker contract test runs those scripts for real,
 * also in an image whose default user has passwordless sudo as on Vercel;
 * this test proves the Vercel call. No Vercel sandbox runs here (T12). The
 * abort of a signalled script runs on real processes in the Docker contract
 * (`ingest-root.contract.test.ts`).
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
