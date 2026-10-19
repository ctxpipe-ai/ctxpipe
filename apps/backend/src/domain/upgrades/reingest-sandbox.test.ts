import { createServer } from "node:net"
import Docker from "dockerode"
import { describe, expect, it } from "vitest"
import { dockerHostError } from "../workspaces/ingest-sandbox-egress.js"
import { ingestSandboxUnavailable } from "./reingest.js"

const vercel = {
  SANDBOX_PROVIDER: "vercel",
  VERCEL_TOKEN: "token",
  VERCEL_TEAM_ID: "team",
  VERCEL_PROJECT_ID: "project",
}

describe("ingestSandboxUnavailable", () => {
  it("lets hosted re-ingestion run on Vercel, as ingestion does", () => {
    expect(ingestSandboxUnavailable(vercel)).toBeNull()
  })

  it("names the missing Vercel settings, not Docker", () => {
    const note = ingestSandboxUnavailable({ ...vercel, VERCEL_TOKEN: "" })
    expect(note).toContain("VERCEL_TOKEN")
    expect(note).not.toContain("Docker")
  })

  it("lets self-host run on Docker", () => {
    expect(ingestSandboxUnavailable({})).toBeNull()
    expect(ingestSandboxUnavailable({ SANDBOX_PROVIDER: "docker" })).toBeNull()
  })

  it("blocks an unsandboxed deployment", () => {
    expect(
      ingestSandboxUnavailable({ SANDBOX_PROVIDER: "unsandboxed" }),
    ).toContain("unsandboxed")
  })
})

const ACTION =
  "Cannot start the Docker sandbox host. Check that your deployment has Docker available."

describe("dockerHostError", () => {
  it("tells the operator what to do when the Docker socket is missing", async () => {
    const error = await new Docker({ socketPath: "/nonexistent/docker.sock" })
      .ping()
      .catch((e: unknown) => e)
    expect((dockerHostError(error) as Error).message).toBe(ACTION)
  })

  it("tells the operator what to do when the Docker host refuses the connection", async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as { port: number }
    await new Promise((resolve) => server.close(resolve))
    const error = await new Docker({
      host: "127.0.0.1",
      port,
      protocol: "http",
    })
      .ping()
      .catch((e: unknown) => e)
    expect((dockerHostError(error) as Error).message).toBe(ACTION)
  })

  it("keeps any other error as it is", () => {
    const error = new Error("No such image")
    expect(dockerHostError(error)).toBe(error)
  })
})
