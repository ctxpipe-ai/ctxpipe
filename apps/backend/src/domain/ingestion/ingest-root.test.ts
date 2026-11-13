import { describe, expect, it } from "vitest"

import { ingestAgentCommand } from "./ingest-opencode.js"
import { assertIngestProvider } from "./ingest-prepare.js"

/*
 * The Docker contract test runs the root scripts for real
 * (`ingest-shard-ops.contract.test.ts`), with the bounded output of a root
 * command. The abort of a signalled script runs on real processes in the
 * Docker contract (`ingest-root.contract.test.ts`).
 */

describe("assertIngestProvider", () => {
  it("accepts Docker and AgentCore", () => {
    expect(() => assertIngestProvider("docker")).not.toThrow()
    expect(() => assertIngestProvider("agentcore")).not.toThrow()
  })

  it("refuses ingest in unsandboxed mode", () => {
    expect(() => assertIngestProvider("local-process")).toThrow(
      /needs a Docker or AgentCore sandbox/,
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
