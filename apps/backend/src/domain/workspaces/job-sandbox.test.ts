import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  createTanstackJobSandbox,
  ensureJobSandbox,
  jobSandboxIsolation,
  resolveJobSandboxIsolation,
} from "./job-sandbox.js"
import { getJobSandbox } from "./sandbox-registry.js"

const claimSandboxInstance = vi.hoisted(() =>
  vi.fn(async (input: { id: string }) => ({
    record: input,
    inserted: true,
  })),
)
const deleteSandboxInstance = vi.hoisted(() => vi.fn(async () => {}))
const persistSandboxInstance = vi.hoisted(() => vi.fn(async () => {}))
const withSandboxAdvisoryLock = vi.hoisted(() =>
  vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
)

vi.mock("../../models/workspaces.js", () => ({
  persistSandboxInstance,
  deleteSandboxInstance,
  claimSandboxInstance,
  listSandboxInstances: vi.fn(async () => []),
  heartbeatSandboxInstance: vi.fn(async () => {}),
  getSandboxInstance: vi.fn(async () => null),
}))

vi.mock("./sandbox-instance-store.js", () => ({
  withSandboxAdvisoryLock,
}))

describe("job sandbox", () => {
  beforeEach(() => {
    claimSandboxInstance.mockReset()
    claimSandboxInstance.mockImplementation(async (input: { id: string }) => ({
      record: input,
      inserted: true,
    }))
    deleteSandboxInstance.mockClear()
    persistSandboxInstance.mockClear()
    withSandboxAdvisoryLock.mockReset()
    withSandboxAdvisoryLock.mockImplementation(
      async (_key: string, fn: () => Promise<unknown>) => fn(),
    )
  })
  it("uses Docker when present and fails closed when Docker is locked but missing", () => {
    expect(jobSandboxIsolation("docker")).toBe("docker")
    expect(jobSandboxIsolation("unsandboxed")).toBe("local_process")
    expect(jobSandboxIsolation("railway")).toBe("local_process")
    expect(
      resolveJobSandboxIsolation({
        provider: "docker",
        hasDocker: false,
        hasLocal: true,
      }),
    ).toBeNull()
    expect(
      resolveJobSandboxIsolation({
        provider: "railway",
        hasDocker: false,
        hasLocal: true,
      }),
    ).toBeNull()
    expect(
      resolveJobSandboxIsolation({
        provider: "unsandboxed",
        hasDocker: false,
        hasLocal: true,
      }),
    ).toBe("local_process")
    expect(
      resolveJobSandboxIsolation({
        provider: "docker",
        hasDocker: true,
        hasLocal: true,
      }),
    ).toBe("docker")
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

  it("creates against the claimed live id and keeps the row when create fails", async () => {
    claimSandboxInstance.mockResolvedValueOnce({
      record: {
        id: "job-claimed",
        kind: "job",
        orgId: "org_1",
        workspaceId: "ws_claim_create",
        state: "live",
        lastHeartbeatAt: new Date(),
      },
      inserted: true,
    })
    const create = vi.fn(async (sandboxId: string) => {
      expect(sandboxId).toBe("job-claimed")
      return null
    })
    expect(
      await ensureJobSandbox({
        orgId: "org_1",
        workspaceId: "ws_claim_create",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        create,
      }),
    ).toBeNull()
    expect(create).toHaveBeenCalledWith("job-claimed")
    expect(deleteSandboxInstance).not.toHaveBeenCalled()
  })

  it("holds the advisory lock across create and resumes the stored provider id", async () => {
    const order: string[] = []
    withSandboxAdvisoryLock.mockImplementation(
      async (_key: string, fn: () => Promise<unknown>) => {
        order.push("lock")
        try {
          return await fn()
        } finally {
          order.push("unlock")
        }
      },
    )
    claimSandboxInstance.mockResolvedValueOnce({
      record: {
        id: "job-claimed-resume",
        kind: "job",
        orgId: "org_1",
        workspaceId: "ws_resume",
        providerSandboxId: "sbx_real",
        state: "live",
        lastHeartbeatAt: new Date(),
      },
      inserted: false,
    })
    const handle = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      fs: {
        write: async () => undefined,
        read: async () => "",
        remove: async () => undefined,
        mkdir: async () => undefined,
      },
    }
    persistSandboxInstance.mockImplementation(async () => {
      order.push("persist")
    })
    const create = vi.fn(async (sandboxId: string) => {
      order.push("create")
      expect(sandboxId).toBe("sbx_real")
      return {
        handle,
        destroy: async () => undefined,
        providerSandboxId: "sbx_real",
      }
    })
    expect(
      await ensureJobSandbox({
        orgId: "org_1",
        workspaceId: "ws_resume",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        create,
      }),
    ).toBe(handle)
    expect(order).toEqual(["lock", "create", "persist", "unlock"])
    expect(withSandboxAdvisoryLock).toHaveBeenCalledWith(
      "sandbox:job:ws_resume",
      expect.any(Function),
    )
  })

  it("persists the provider id returned by create, not the logical claim id", async () => {
    claimSandboxInstance.mockResolvedValueOnce({
      record: {
        id: "job-claimed-id",
        kind: "job",
        orgId: "org_1",
        workspaceId: "ws_provider_id",
        state: "live",
        lastHeartbeatAt: new Date(),
      },
      inserted: true,
    })
    const handle = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      fs: {
        write: async () => undefined,
        read: async () => "",
        remove: async () => undefined,
        mkdir: async () => undefined,
      },
    }
    await ensureJobSandbox({
      orgId: "org_1",
      workspaceId: "ws_provider_id",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      create: async () => ({
        handle,
        destroy: async () => undefined,
        providerSandboxId: "docker-xyz",
      }),
    })
    expect(getJobSandbox("ws_provider_id")).toBe(handle)
    expect(persistSandboxInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "job-claimed-id",
        providerSandboxId: "docker-xyz",
      }),
    )
  })

  it("destroys the created sandbox if persisting the live row fails", async () => {
    claimSandboxInstance.mockResolvedValueOnce({
      record: {
        id: "job-claimed-persist-fail",
        kind: "job",
        orgId: "org_1",
        workspaceId: "ws_persist_fail",
        state: "live",
        lastHeartbeatAt: new Date(),
      },
      inserted: true,
    })
    persistSandboxInstance.mockRejectedValueOnce(new Error("db down"))
    const destroy = vi.fn(async () => undefined)
    const handle = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      fs: {
        write: async () => undefined,
        read: async () => "",
        remove: async () => undefined,
        mkdir: async () => undefined,
      },
    }
    await expect(
      ensureJobSandbox({
        orgId: "org_1",
        workspaceId: "ws_persist_fail",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        create: async () => ({
          handle,
          destroy,
          providerSandboxId: "docker-xyz",
        }),
      }),
    ).rejects.toThrow("db down")
    expect(destroy).toHaveBeenCalled()
  })

  it("does not delete a claimed live id when create throws", async () => {
    claimSandboxInstance.mockResolvedValueOnce({
      record: {
        id: "job-claimed-throw",
        kind: "job",
        orgId: "org_1",
        workspaceId: "ws_claim_throw",
        state: "live",
        lastHeartbeatAt: new Date(),
      },
      inserted: true,
    })
    await expect(
      ensureJobSandbox({
        orgId: "org_1",
        workspaceId: "ws_claim_throw",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        create: async () => {
          throw new Error("clone failed")
        },
      }),
    ).rejects.toThrow("clone failed")
    expect(deleteSandboxInstance).not.toHaveBeenCalled()
  })

  it("creates a local-process job sandbox and clones without leaking a token into exec env", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }))
    const clone = vi.fn(async () => undefined)
    const destroy = vi.fn(async () => undefined)
    const raw = {
      id: "sbx_job_1",
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
    expect(created?.providerSandboxId).toBe("sbx_job_1")
    expect(created?.handle.exec).toEqual(expect.any(Function))
    expect(clone).toHaveBeenCalledWith({
      url: "https://github.com/acme/docs",
      ref: "abc",
      auth: { token: "tok" },
      depth: 1,
    })
    expect(exec).toHaveBeenCalledWith(
      "git remote set-url origin https://github.com/acme/docs",
    )
    expect(exec).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        env: expect.objectContaining({ GITHUB_TOKEN: "tok" }),
      }),
    )
  })

  it("fetches extra merge SHAs before scrubbing origin", async () => {
    const exec = vi.fn(async (command: string) => {
      if (command.startsWith("git fetch ")) {
        return { stdout: "", stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    })
    const clone = vi.fn(async () => undefined)
    await createTanstackJobSandbox({
      sandboxId: "job-1",
      gitUrl: "https://github.com/acme/docs",
      ref: "bbb2222",
      fetchShas: ["aaa1111"],
      cloneToken: "tok",
      env: {},
      loadModules: async () => ({
        localProcessSandbox: () => ({
          create: async () => ({
            id: "sbx_job_1",
            process: { exec },
            fs: {
              write: async () => undefined,
              read: async () => "",
              remove: async () => undefined,
              mkdir: async () => undefined,
            },
            git: { clone },
            destroy: async () => undefined,
          }),
        }),
      }),
    })
    const commands = exec.mock.calls.map((call) => call[0])
    expect(commands).toEqual([
      "git fetch --depth=1 origin aaa1111",
      "git remote set-url origin https://github.com/acme/docs",
    ])
  })

  it("throws when clone fails instead of seeding an empty repo", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }))
    const clone = vi.fn(async () => {
      throw new Error("clone failed")
    })
    const destroy = vi.fn(async () => undefined)
    await expect(
      createTanstackJobSandbox({
        sandboxId: "job-1",
        gitUrl: "https://github.com/acme/docs",
        ref: "abc",
        env: {},
        loadModules: async () => ({
          localProcessSandbox: () => ({
            create: async () => ({
              process: { exec },
              fs: {
                write: async () => undefined,
                read: async () => "",
                remove: async () => undefined,
                mkdir: async () => undefined,
              },
              git: { clone },
              destroy,
            }),
          }),
        }),
      }),
    ).rejects.toThrow("clone failed")
    expect(exec).not.toHaveBeenCalledWith("git init")
    expect(destroy).toHaveBeenCalled()
  })

  it("throws when the sandbox has no git clone API", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }))
    await expect(
      createTanstackJobSandbox({
        sandboxId: "job-1",
        gitUrl: "https://github.com/acme/docs",
        ref: "abc",
        env: {},
        loadModules: async () => ({
          localProcessSandbox: () => ({
            create: async () => ({
              process: { exec },
              fs: {
                write: async () => undefined,
                read: async () => "",
                remove: async () => undefined,
                mkdir: async () => undefined,
              },
              destroy: async () => undefined,
            }),
          }),
        }),
      }),
    ).rejects.toThrow("Job sandbox has no git clone API")
    expect(exec).not.toHaveBeenCalledWith("git init")
  })

  it("resumes an existing provider sandbox instead of creating a second one", async () => {
    const clone = vi.fn(async () => undefined)
    const create = vi.fn()
    const resume = vi.fn(async (input: { id: string }) => {
      expect(input.id).toBe("sbx_live")
      return {
        id: "sbx_live",
        process: {
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        },
        fs: {
          write: async () => undefined,
          read: async () => "",
          remove: async () => undefined,
          mkdir: async () => undefined,
        },
        git: { clone },
        destroy: async () => undefined,
      }
    })
    const created = await createTanstackJobSandbox({
      sandboxId: "sbx_live",
      gitUrl: "https://github.com/acme/docs",
      ref: "abc",
      env: {},
      loadModules: async () => ({
        localProcessSandbox: () => ({ create, resume }),
      }),
    })
    expect(created?.providerSandboxId).toBe("sbx_live")
    expect(resume).toHaveBeenCalledWith({ id: "sbx_live" })
    expect(create).not.toHaveBeenCalled()
    expect(clone).not.toHaveBeenCalled()
  })
})
