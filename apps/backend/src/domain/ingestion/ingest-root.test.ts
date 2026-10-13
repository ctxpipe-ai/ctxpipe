import { describe, expect, it } from "vitest"
import { ingestAgentCommand } from "./ingest-opencode.js"
import { INGEST_AGENT_USER, ingestAgentUser } from "./ingest-prepare.js"
import { vercelRunAsRoot } from "./ingest-root.js"

/*
 * The hosted path runs the same root script as Docker, through the Vercel
 * SDK's `sudo` option. The Docker contract test runs that script for real;
 * this test proves the Vercel call. No Vercel sandbox runs here.
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
            stream === "stderr" ? stderr : "",
        }
      },
    },
  }
}

describe("vercelRunAsRoot", () => {
  it("runs the script with sudo through sh", async () => {
    const { calls, sandbox } = fakeSandbox(0)
    await vercelRunAsRoot(sandbox)("mkdir -p /ctxpipe")
    expect(calls).toEqual([
      { cmd: "sh", args: ["-c", "mkdir -p /ctxpipe"], sudo: true },
    ])
  })

  it("throws with the stderr when the script fails", async () => {
    const { sandbox } = fakeSandbox(1, "sudo: not allowed")
    await expect(vercelRunAsRoot(sandbox)("true")).rejects.toThrow(
      /exit 1.*sudo: not allowed/,
    )
  })
})

describe("ingestAgentUser", () => {
  it("runs the Vercel agent as a separate user and the Docker agent as the image user", () => {
    expect(ingestAgentUser("vercel")).toBe(INGEST_AGENT_USER)
    expect(ingestAgentUser("docker")).toBeNull()
  })

  it("refuses ingest in unsandboxed mode", () => {
    expect(() => ingestAgentUser("local-process")).toThrow(
      /needs a Docker or Vercel sandbox/,
    )
  })
})

describe("ingestAgentCommand", () => {
  it("starts the Vercel agent through sudo -u with only the given env", () => {
    expect(
      ingestAgentCommand({
        agentUser: INGEST_AGENT_USER,
        env: { HOME: "/ctxpipe/home" },
        command: "opencode --version",
      }),
    ).toBe(
      "sudo -n -u ctxpipe-agent -- env -i 'HOME=/ctxpipe/home' sh -c 'cd /ctxpipe/out && opencode --version'",
    )
  })
})
