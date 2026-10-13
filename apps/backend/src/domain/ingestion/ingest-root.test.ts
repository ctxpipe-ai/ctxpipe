import { describe, expect, it } from "vitest"
import { vercelRunAsRoot } from "./ingest-root.js"
import { ingestLayoutScript } from "./skill-bundle.js"

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

describe("ingestLayoutScript", () => {
  it("makes /ctxpipe root-owned with only /ctxpipe/out for the sandbox user", () => {
    const script = ingestLayoutScript("1000:1000")
    expect(script).toContain("chown root:root /ctxpipe /ctxpipe/context")
    expect(script).toContain("chmod 755 /ctxpipe /ctxpipe/context")
    expect(script).toContain("chown 1000:1000 /ctxpipe/out")
  })

  it("refuses an owner that is not uid:gid", () => {
    expect(() => ingestLayoutScript("node; rm -rf /")).toThrow(/uid:gid/)
  })
})
