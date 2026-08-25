import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ClaimedSandboxInstance,
  SandboxInstanceRecord,
} from "../../models/workspaces.js"
import {
  createTanstackJobSandbox,
  ensureJobSandbox,
  jobSandboxIsolation,
  resolveJobSandboxIsolation,
} from "./job-sandbox.js"
import { getJobSandbox } from "./sandbox-registry.js"

const claimSandboxInstance = vi.hoisted(() =>
  vi.fn(
    async (input: SandboxInstanceRecord): Promise<ClaimedSandboxInstance> => ({
      record: input,
      inserted: true,
    }),
  ),
)
const deleteSandboxInstance = vi.hoisted(() => vi.fn(async () => {}))
const persistSandboxInstance = vi.hoisted(() => vi.fn(async () => {}))

vi.mock("../../models/workspaces.js", () => ({
  persistSandboxInstance,
  deleteSandboxInstance,
  claimSandboxInstance,
  listSandboxInstances: vi.fn(async () => []),
  heartbeatSandboxInstance: vi.fn(async () => {}),
  getSandboxInstance: vi.fn(async () => null),
}))

const destroyDetachedProviderSandbox = vi.hoisted(() => vi.fn(async () => {}))

vi.mock("./sandbox-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sandbox-provider.js")>()
  return {
    ...actual,
    destroyDetachedProviderSandbox,
  }
})

describe("job sandbox", () => {
  beforeEach(() => {
    claimSandboxInstance.mockReset()
    claimSandboxInstance.mockImplementation(
      async (input: SandboxInstanceRecord) => ({
        record: input,
        inserted: true,
      }),
    )
    deleteSandboxInstance.mockClear()
    persistSandboxInstance.mockClear()
    destroyDetachedProviderSandbox.mockReset()
    destroyDetachedProviderSandbox.mockResolvedValue(undefined)
  })
  it("uses Docker when present and fails closed when Docker is locked but missing", () => {
    expect(jobSandboxIsolation("docker")).toBe("docker")
    expect(jobSandboxIsolation("unsandboxed")).toBeNull()
    expect(jobSandboxIsolation("railway")).toBeNull()
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
    ).toBeNull()
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
    expect(create).toHaveBeenCalledWith(
      "job-claimed",
      expect.objectContaining({
        persistLive: expect.any(Function),
        abandon: expect.any(Function),
      }),
    )
    expect(deleteSandboxInstance).not.toHaveBeenCalled()
  })

  it("resumes a stored provider id without an advisory lock", async () => {
    claimSandboxInstance.mockResolvedValueOnce({
      record: {
        id: "job-claimed-resume",
        kind: "job",
        orgId: "org_1",
        workspaceId: "ws_resume",
        providerSandboxId: "sbx_real",
        provider: "docker",
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
    const create = vi.fn(async (sandboxId: string) => {
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
    expect(create).toHaveBeenCalledWith(
      "sbx_real",
      expect.objectContaining({
        storedProvider: "docker",
        persistLive: expect.any(Function),
        abandon: expect.any(Function),
      }),
    )
  })

  it("does not create a second provider when claim was not inserted and has no provider id", async () => {
    claimSandboxInstance.mockResolvedValueOnce({
      record: {
        id: "job-claimed-conflict",
        kind: "job",
        orgId: "org_1",
        workspaceId: "ws_conflict",
        state: "live",
        lastHeartbeatAt: new Date(),
      },
      inserted: false,
    })
    const create = vi.fn()
    expect(
      await ensureJobSandbox({
        orgId: "org_1",
        workspaceId: "ws_conflict",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        create,
      }),
    ).toBeNull()
    expect(create).not.toHaveBeenCalled()
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
          provider: "docker",
        }),
      }),
    ).rejects.toThrow("db down")
    expect(destroy).toHaveBeenCalled()
    expect(deleteSandboxInstance).toHaveBeenCalledWith(
      "job-claimed-persist-fail",
      "org_1",
    )
  })

  it("stores provider metadata when persistLive runs during create", async () => {
    claimSandboxInstance.mockResolvedValueOnce({
      record: {
        id: "job-claimed-live",
        kind: "job",
        orgId: "org_1",
        workspaceId: "ws_persist_live",
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
      workspaceId: "ws_persist_live",
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      create: async (_sandboxId, hooks) => {
        await hooks.persistLive({
          providerSandboxId: "sbx_docker_1",
          provider: "docker",
        })
        return {
          handle,
          destroy: async () => undefined,
          providerSandboxId: "sbx_docker_1",
          provider: "docker",
        }
      },
    })
    expect(persistSandboxInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "job-claimed-live",
        provider: "docker",
        providerSandboxId: "sbx_docker_1",
        state: "live",
      }),
    )
  })

  it("deletes the claimed row when create abandons a destroyed sandbox", async () => {
    claimSandboxInstance.mockResolvedValueOnce({
      record: {
        id: "job-claimed-abandon",
        kind: "job",
        orgId: "org_1",
        workspaceId: "ws_abandon_destroyed",
        state: "live",
        lastHeartbeatAt: new Date(),
      },
      inserted: true,
    })
    await expect(
      ensureJobSandbox({
        orgId: "org_1",
        workspaceId: "ws_abandon_destroyed",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        create: async (_sandboxId, hooks) => {
          await hooks.abandon({
            providerSandboxId: "sbx_docker_1",
            provider: "docker",
            destroyed: true,
          })
          throw new Error("clone failed")
        },
      }),
    ).rejects.toThrow("clone failed")
    expect(deleteSandboxInstance).toHaveBeenCalledWith(
      "job-claimed-abandon",
      "org_1",
    )
  })

  it("marks destroy_failed when create abandons a sandbox that is still running", async () => {
    claimSandboxInstance.mockResolvedValueOnce({
      record: {
        id: "job-claimed-abandon-fail",
        kind: "job",
        orgId: "org_1",
        workspaceId: "ws_abandon_running",
        state: "live",
        lastHeartbeatAt: new Date(),
      },
      inserted: true,
    })
    await expect(
      ensureJobSandbox({
        orgId: "org_1",
        workspaceId: "ws_abandon_running",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        create: async (_sandboxId, hooks) => {
          await hooks.abandon({
            providerSandboxId: "sbx_docker_1",
            provider: "docker",
            destroyed: false,
          })
          throw new Error("clone failed")
        },
      }),
    ).rejects.toThrow("clone failed")
    expect(deleteSandboxInstance).not.toHaveBeenCalled()
    expect(persistSandboxInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "job-claimed-abandon-fail",
        provider: "docker",
        providerSandboxId: "sbx_docker_1",
        state: "destroy_failed",
      }),
    )
  })

  it("marks destroy_failed with provider metadata when register cleanup cannot destroy", async () => {
    claimSandboxInstance.mockResolvedValueOnce({
      record: {
        id: "job-claimed-destroy-fail",
        kind: "job",
        orgId: "org_1",
        workspaceId: "ws_register_destroy_fail",
        state: "live",
        lastHeartbeatAt: new Date(),
      },
      inserted: true,
    })
    persistSandboxInstance.mockRejectedValueOnce(new Error("db down"))
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
        workspaceId: "ws_register_destroy_fail",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
        create: async () => ({
          handle,
          destroy: async () => {
            throw new Error("still running")
          },
          providerSandboxId: "sbx_docker_1",
          provider: "docker",
        }),
      }),
    ).rejects.toThrow("db down")
    expect(deleteSandboxInstance).not.toHaveBeenCalled()
    expect(persistSandboxInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "job-claimed-destroy-fail",
        provider: "docker",
        providerSandboxId: "sbx_docker_1",
        state: "destroy_failed",
      }),
    )
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
      env: { SANDBOX_PROVIDER: "docker" },
      loadModules: async () => ({
        dockerSandbox: () => ({
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
      env: { SANDBOX_PROVIDER: "docker" },
      loadModules: async () => ({
        dockerSandbox: () => ({
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
        env: { SANDBOX_PROVIDER: "docker" },
        loadModules: async () => ({
          dockerSandbox: () => ({
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
        env: { SANDBOX_PROVIDER: "docker" },
        loadModules: async () => ({
          dockerSandbox: () => ({
            create: async () => ({
              id: "sbx_job_1",
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
      storedProvider: "docker",
      gitUrl: "https://github.com/acme/docs",
      ref: "abc",
      env: { SANDBOX_PROVIDER: "docker" },
      loadModules: async () => ({
        dockerSandbox: () => ({ create, resume }),
      }),
    })
    expect(created?.providerSandboxId).toBe("sbx_live")
    expect(resume).toHaveBeenCalledWith({ id: "sbx_live" })
    expect(create).not.toHaveBeenCalled()
    expect(clone).not.toHaveBeenCalled()
  })

  it("persists the provider id before cloning the workspace repository", async () => {
    const order: string[] = []
    const persistProviderId = vi.fn(async () => {
      order.push("persist")
    })
    const clone = vi.fn(async () => {
      order.push("clone")
    })
    await createTanstackJobSandbox({
      sandboxId: "job-1",
      gitUrl: "https://github.com/acme/docs",
      ref: "abc",
      env: { SANDBOX_PROVIDER: "docker" },
      persistProviderId,
      loadModules: async () => ({
        dockerSandbox: () => ({
          create: async () => ({
            id: "sbx_job_1",
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
          }),
        }),
      }),
    })
    expect(order).toEqual(["persist", "clone"])
    expect(persistProviderId).toHaveBeenCalledWith({
      providerSandboxId: "sbx_job_1",
      provider: "docker",
    })
  })

  it("persists docker as the provider before cloning", async () => {
    const persistProviderId = vi.fn(async () => undefined)
    await createTanstackJobSandbox({
      sandboxId: "job-1",
      gitUrl: "https://github.com/acme/docs",
      ref: "abc",
      env: { SANDBOX_PROVIDER: "docker" },
      persistProviderId,
      loadModules: async () => ({
        dockerSandbox: () => ({
          create: async () => ({
            id: "sbx_docker_1",
            process: {
              exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
            },
            fs: {
              write: async () => undefined,
              read: async () => "",
              remove: async () => undefined,
              mkdir: async () => undefined,
            },
            git: { clone: async () => undefined },
            destroy: async () => undefined,
          }),
        }),
      }),
    })
    expect(persistProviderId).toHaveBeenCalledWith({
      providerSandboxId: "sbx_docker_1",
      provider: "docker",
    })
  })

  it("abandons a created sandbox as destroyed when clone cleanup succeeds", async () => {
    const abandonCreated = vi.fn(async () => undefined)
    const destroy = vi.fn(async () => undefined)
    await expect(
      createTanstackJobSandbox({
        sandboxId: "job-1",
        gitUrl: "https://github.com/acme/docs",
        ref: "abc",
        env: { SANDBOX_PROVIDER: "docker" },
        persistProviderId: async () => undefined,
        abandonCreated,
        loadModules: async () => ({
          dockerSandbox: () => ({
            create: async () => ({
              id: "sbx_docker_1",
              process: {
                exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
              },
              fs: {
                write: async () => undefined,
                read: async () => "",
                remove: async () => undefined,
                mkdir: async () => undefined,
              },
              git: {
                clone: async () => {
                  throw new Error("clone failed")
                },
              },
              destroy,
            }),
          }),
        }),
      }),
    ).rejects.toThrow("clone failed")
    expect(destroy).toHaveBeenCalled()
    expect(abandonCreated).toHaveBeenCalledWith({
      providerSandboxId: "sbx_docker_1",
      provider: "docker",
      destroyed: true,
    })
  })

  it("abandons a created sandbox as destroy_failed when clone cleanup cannot destroy", async () => {
    const abandonCreated = vi.fn(async () => undefined)
    await expect(
      createTanstackJobSandbox({
        sandboxId: "job-1",
        gitUrl: "https://github.com/acme/docs",
        ref: "abc",
        env: { SANDBOX_PROVIDER: "docker" },
        persistProviderId: async () => undefined,
        abandonCreated,
        loadModules: async () => ({
          dockerSandbox: () => ({
            create: async () => ({
              id: "sbx_docker_1",
              process: {
                exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
              },
              fs: {
                write: async () => undefined,
                read: async () => "",
                remove: async () => undefined,
                mkdir: async () => undefined,
              },
              git: {
                clone: async () => {
                  throw new Error("clone failed")
                },
              },
              destroy: async () => {
                throw new Error("still running")
              },
            }),
          }),
        }),
      }),
    ).rejects.toThrow("clone failed")
    expect(abandonCreated).toHaveBeenCalledWith({
      providerSandboxId: "sbx_docker_1",
      provider: "docker",
      destroyed: false,
    })
  })

  it("does not resume a stored docker sandbox when the current env is not docker", async () => {
    const dockerResume = vi.fn()
    const localCreate = vi.fn()
    await expect(
      createTanstackJobSandbox({
        sandboxId: "sbx_docker",
        storedProvider: "docker",
        gitUrl: "https://github.com/acme/docs",
        ref: "abc",
        env: {},
        loadModules: async () => ({
          dockerSandbox: () => ({ create: vi.fn(), resume: dockerResume }),
          localProcessSandbox: () => ({ create: localCreate }),
        }),
      }),
    ).rejects.toThrow(/locked or unavailable/)
    expect(dockerResume).not.toHaveBeenCalled()
    expect(localCreate).not.toHaveBeenCalled()
  })

  it("resumes a stored docker sandbox only when Docker is the effective provider", async () => {
    const dockerResume = vi.fn(async (input: { id: string }) => {
      expect(input.id).toBe("sbx_docker")
      return {
        id: "sbx_docker",
        process: {
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        },
        fs: {
          write: async () => undefined,
          read: async () => "",
          remove: async () => undefined,
          mkdir: async () => undefined,
        },
        git: { clone: async () => undefined },
        destroy: async () => undefined,
      }
    })
    const created = await createTanstackJobSandbox({
      sandboxId: "sbx_docker",
      storedProvider: "docker",
      gitUrl: "https://github.com/acme/docs",
      ref: "abc",
      env: { SANDBOX_PROVIDER: "docker" },
      loadModules: async () => ({
        dockerSandbox: () => ({ create: vi.fn(), resume: dockerResume }),
      }),
    })
    expect(created?.providerSandboxId).toBe("sbx_docker")
    expect(created?.provider).toBe("docker")
    expect(dockerResume).toHaveBeenCalledWith({ id: "sbx_docker" })
    expect(destroyDetachedProviderSandbox).not.toHaveBeenCalled()
  })

  it("destroys a stored sbx sandbox when Docker is locked, then creates Docker", async () => {
    const sbxResume = vi.fn()
    const dockerCreate = vi.fn(async () => ({
      id: "ctr_docker",
      process: {
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      },
      fs: {
        write: async () => undefined,
        read: async () => "",
        remove: async () => undefined,
        mkdir: async () => undefined,
      },
      git: { clone: async () => undefined },
      destroy: async () => undefined,
    }))
    const created = await createTanstackJobSandbox({
      sandboxId: "sbx_vm",
      storedProvider: "sbx",
      gitUrl: "https://github.com/acme/docs",
      ref: "abc",
      env: { SANDBOX_PROVIDER: "docker" },
      persistProviderId: async () => undefined,
      loadModules: async () => ({
        sbxSandbox: () => ({ create: vi.fn(), resume: sbxResume }),
        dockerSandbox: () => ({ create: dockerCreate, resume: async () => null }),
      }),
    })
    expect(sbxResume).not.toHaveBeenCalled()
    expect(destroyDetachedProviderSandbox).toHaveBeenCalledWith({
      provider: "sbx",
      providerSandboxId: "sbx_vm",
    })
    expect(dockerCreate).toHaveBeenCalled()
    expect(created?.providerSandboxId).toBe("ctr_docker")
    expect(created?.provider).toBe("docker")
  })
})
