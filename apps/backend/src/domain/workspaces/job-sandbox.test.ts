import { describe, expect, it, vi } from "vitest"
import {
  createTanstackJobSandbox,
  ensureJobSandbox,
  jobSandboxIsolation,
  resolveJobSandboxIsolation,
} from "./job-sandbox.js"
import { getJobSandbox } from "./sandbox-registry.js"

describe("job sandbox", () => {
  it("uses Docker when present and falls back to in-process", () => {
    expect(jobSandboxIsolation("docker")).toBe("docker")
    expect(jobSandboxIsolation("unsandboxed")).toBe("local_process")
    expect(jobSandboxIsolation("railway")).toBe("local_process")
    expect(
      resolveJobSandboxIsolation({
        provider: "docker",
        hasDocker: false,
        hasLocal: true,
      }),
    ).toBe("local_process")
    expect(
      resolveJobSandboxIsolation({
        provider: "unsandboxed",
        hasDocker: false,
        hasLocal: true,
      }),
    ).toBe("local_process")
  })

  it("reuses an attached handle and otherwise creates one", async () => {
    const existing = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      fs: {
        write: async () => undefined,
        read: async () => "",
        remove: async () => undefined,
        mkdir: async () => undefined,
      },
    }
    const create = vi.fn()
    expect(
      await ensureJobSandbox({
        orgId: "org_1",
        workspaceId: "ws_existing",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        existing,
        create,
      }),
    ).toBe(existing)
    expect(create).not.toHaveBeenCalled()

    const created = {
      handle: existing,
      destroy: async () => undefined,
    }
    expect(
      await ensureJobSandbox({
        orgId: "org_1",
        workspaceId: "ws_created",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        create: async () => created,
      }),
    ).toBe(existing)
    expect(getJobSandbox("ws_created")).toBe(existing)
  })

  it("creates a local-process job sandbox and clones without leaking a token into exec env", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }))
    const clone = vi.fn(async () => undefined)
    const destroy = vi.fn(async () => undefined)
    const raw = {
      process: { exec },
      fs: {
        write: async () => undefined,
        read: async () => "",
        remove: async () => undefined,
        mkdir: async () => undefined,
      },
      git: { clone },
      destroy,
    }
    const created = await createTanstackJobSandbox({
      sandboxId: "job-1",
      gitUrl: "https://github.com/acme/docs",
      ref: "abc",
      cloneToken: "tok",
      env: {},
      loadModules: async () => ({
        localProcessSandbox: () => ({
          create: async () => raw,
        }),
      }),
    })
    expect(created?.handle.fs).toBe(raw.fs)
    expect(created?.handle.exec).toEqual(expect.any(Function))
    expect(clone).toHaveBeenCalledWith({
      url: "https://github.com/acme/docs",
      ref: "abc",
      auth: { token: "tok" },
      depth: 1,
    })
    expect(exec).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        env: expect.objectContaining({ GITHUB_TOKEN: "tok" }),
      }),
    )
  })
})
