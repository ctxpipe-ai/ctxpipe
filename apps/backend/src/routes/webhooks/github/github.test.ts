import { OpenAPIHono } from "@hono/zod-openapi"
import { Webhooks } from "@octokit/webhooks"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../../app/env.js"
import { parseEnv } from "../../../config/env.js"
import { repositoryIngestion } from "../../../openworkflow/repository-ingestion.js"
import { syncGithubRepositories } from "../../../openworkflow/sync-github-repositories.js"

const runWorkflowMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ workflowRun: { id: "wr_1" } }),
)

vi.mock("../../../models/github-installation.js", () => ({
  listInstallationsByGithubInstallationId: vi.fn(),
}))

vi.mock("../../../models/repositories.js", () => ({
  findRepositoryByGithubInstallation: vi.fn(),
}))

vi.mock("../../../openworkflow/client.js", () => ({
  ow: { runWorkflow: runWorkflowMock },
}))

import { listInstallationsByGithubInstallationId } from "../../../models/github-installation.js"
import { findRepositoryByGithubInstallation } from "../../../models/repositories.js"
import { registerGithubWebhookRoute } from "./github.js"

const listInstallationsMock = vi.mocked(listInstallationsByGithubInstallationId)
const findRepoMock = vi.mocked(findRepositoryByGithubInstallation)

const baseInstallationRow = {
  installationId: 999,
  ingestAllRepositories: false,
  includeFutureRepos: false,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe("GitHub webhook HMAC", () => {
  it("matches GitHub documentation test vector", async () => {
    const secret = "It's a Secret to Everybody"
    const payload = "Hello, World!"
    const w = new Webhooks({ secret })
    const sig =
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"
    await expect(w.verify(payload, sig)).resolves.toBe(true)
  })
})

describe("POST /api/v1/webhook/github", () => {
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/ctxpipe",
    AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
    GITHUB_WEBHOOK_SECRET: "test-secret-for-webhooks",
  } as Record<string, string | undefined>)

  const webhookSecret = "test-secret-for-webhooks"

  beforeEach(() => {
    vi.clearAllMocks()
    runWorkflowMock.mockResolvedValue({ workflowRun: { id: "wr_1" } })
    listInstallationsMock.mockReset()
    findRepoMock.mockReset()
  })

  function createTestApp() {
    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("env", env)
      c.set("log", {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
      } as unknown as AppEnv["Variables"]["log"])
      await next()
    })
    registerGithubWebhookRoute(app)
    return app
  }

  it("returns 401 when signature is invalid", async () => {
    const app = createTestApp()
    const res = await app.request("/api/v1/webhook/github", {
      method: "POST",
      headers: {
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=deadbeef",
        "content-type": "application/json",
      },
      body: "{}",
    })
    expect(res.status).toBe(401)
  })

  it("returns 503 when webhook secret is not configured", async () => {
    const envNoSecret = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://localhost:5432/ctxpipe",
      AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
    } as Record<string, string | undefined>)

    const app = new OpenAPIHono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("env", envNoSecret)
      c.set("log", { error: vi.fn() } as unknown as AppEnv["Variables"]["log"])
      await next()
    })
    registerGithubWebhookRoute(app)

    const res = await app.request("/api/v1/webhook/github", {
      method: "POST",
      headers: {
        "x-github-event": "ping",
        "content-type": "application/json",
      },
      body: "{}",
    })
    expect(res.status).toBe(503)
  })

  it("on push to default branch enqueues repository ingestion", async () => {
    listInstallationsMock.mockResolvedValue([
      {
        id: "ghi_1",
        orgId: "org_1",
        ...baseInstallationRow,
      },
    ])
    findRepoMock.mockResolvedValue({
      id: "repo_abc",
      orgId: "org_1",
      name: "acme/app",
      gitUrl: "https://github.com/acme/app.git",
      indexReady: true,
      lastIngestedHash: "abc",
      githubInstallationId: "ghi_1",
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const app = createTestApp()
    const payload = {
      ref: "refs/heads/main",
      repository: {
        full_name: "acme/app",
        default_branch: "main",
      },
      installation: { id: 999 },
    }
    const body = JSON.stringify(payload)
    const w = new Webhooks({ secret: webhookSecret })
    const sig = await w.sign(body)

    const res = await app.request("/api/v1/webhook/github", {
      method: "POST",
      headers: {
        "x-github-event": "push",
        "x-hub-signature-256": sig,
        "content-type": "application/json",
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(runWorkflowMock).toHaveBeenCalledWith(repositoryIngestion.spec, {
      repositoryId: "repo_abc",
      orgId: "org_1",
    })
  })

  it("on push enqueues ingestion for each org linked to the same installation id", async () => {
    listInstallationsMock.mockResolvedValue([
      {
        id: "ghi_1",
        orgId: "org_1",
        ...baseInstallationRow,
      },
      {
        id: "ghi_2",
        orgId: "org_2",
        ...baseInstallationRow,
      },
    ])
    findRepoMock
      .mockResolvedValueOnce({
        id: "repo_a",
        orgId: "org_1",
        name: "acme/app",
        gitUrl: "https://github.com/acme/app.git",
        indexReady: true,
        lastIngestedHash: "a",
        githubInstallationId: "ghi_1",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: "repo_b",
        orgId: "org_2",
        name: "acme/app",
        gitUrl: "https://github.com/acme/app.git",
        indexReady: true,
        lastIngestedHash: "b",
        githubInstallationId: "ghi_2",
        createdAt: new Date(),
        updatedAt: new Date(),
      })

    const app = createTestApp()
    const payload = {
      ref: "refs/heads/main",
      repository: {
        full_name: "acme/app",
        default_branch: "main",
      },
      installation: { id: 999 },
    }
    const body = JSON.stringify(payload)
    const w = new Webhooks({ secret: webhookSecret })
    const sig = await w.sign(body)

    const res = await app.request("/api/v1/webhook/github", {
      method: "POST",
      headers: {
        "x-github-event": "push",
        "x-hub-signature-256": sig,
        "content-type": "application/json",
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(runWorkflowMock).toHaveBeenCalledTimes(2)
    expect(runWorkflowMock).toHaveBeenCalledWith(repositoryIngestion.spec, {
      repositoryId: "repo_a",
      orgId: "org_1",
    })
    expect(runWorkflowMock).toHaveBeenCalledWith(repositoryIngestion.spec, {
      repositoryId: "repo_b",
      orgId: "org_2",
    })
  })

  it("repository created with both flags enqueues sync workflow", async () => {
    listInstallationsMock.mockResolvedValue([
      {
        id: "ghi_1",
        orgId: "org_1",
        installationId: 999,
        ingestAllRepositories: true,
        includeFutureRepos: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])

    const app = createTestApp()
    const payload = {
      action: "created" as const,
      repository: {
        full_name: "acme/new-repo",
        clone_url: "https://github.com/acme/new-repo.git",
      },
      installation: { id: 999 },
    }
    const body = JSON.stringify(payload)
    const w = new Webhooks({ secret: webhookSecret })
    const sig = await w.sign(body)

    const res = await app.request("/api/v1/webhook/github", {
      method: "POST",
      headers: {
        "x-github-event": "repository",
        "x-hub-signature-256": sig,
        "content-type": "application/json",
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(runWorkflowMock).toHaveBeenCalledWith(syncGithubRepositories.spec, {
      orgId: "org_1",
      githubConnectionId: "ghi_1",
      reposToSync: [
        {
          name: "acme/new-repo",
          gitUrl: "https://github.com/acme/new-repo.git",
        },
      ],
    })
  })

  it("repository created enqueues sync for each org with auto-sync enabled", async () => {
    listInstallationsMock.mockResolvedValue([
      {
        id: "ghi_1",
        orgId: "org_1",
        installationId: 999,
        ingestAllRepositories: true,
        includeFutureRepos: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "ghi_2",
        orgId: "org_2",
        installationId: 999,
        ingestAllRepositories: true,
        includeFutureRepos: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])

    const app = createTestApp()
    const payload = {
      action: "created" as const,
      repository: {
        full_name: "acme/new-repo",
        clone_url: "https://github.com/acme/new-repo.git",
      },
      installation: { id: 999 },
    }
    const body = JSON.stringify(payload)
    const w = new Webhooks({ secret: webhookSecret })
    const sig = await w.sign(body)

    const res = await app.request("/api/v1/webhook/github", {
      method: "POST",
      headers: {
        "x-github-event": "repository",
        "x-hub-signature-256": sig,
        "content-type": "application/json",
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(runWorkflowMock).toHaveBeenCalledTimes(2)
    expect(runWorkflowMock).toHaveBeenCalledWith(syncGithubRepositories.spec, {
      orgId: "org_1",
      githubConnectionId: "ghi_1",
      reposToSync: [
        {
          name: "acme/new-repo",
          gitUrl: "https://github.com/acme/new-repo.git",
        },
      ],
    })
    expect(runWorkflowMock).toHaveBeenCalledWith(syncGithubRepositories.spec, {
      orgId: "org_2",
      githubConnectionId: "ghi_2",
      reposToSync: [
        {
          name: "acme/new-repo",
          gitUrl: "https://github.com/acme/new-repo.git",
        },
      ],
    })
  })
})
