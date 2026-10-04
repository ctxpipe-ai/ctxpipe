import { generateKeyPairSync } from "node:crypto"
import { OpenAPIHono } from "@hono/zod-openapi"
import { Webhooks } from "@octokit/webhooks"
import { evlog } from "evlog/hono"
import { contextStorage } from "hono/context-storage"
import { HttpResponse, http } from "msw"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  cleanupSeededOrg,
  type SeededOrg,
  seedOrg,
} from "../../../../test/db.js"
import { useMswServer } from "../../../../test/msw.js"
import { recordSpans } from "../../../../test/spans.js"
import type { AppEnv } from "../../../app/env.js"
import { parseEnv } from "../../../config/env.js"
import {
  createDraftGithubConnection,
  createPlaceholderGithubConnection,
  deleteGithubConnectionById,
  listGithubConnectionsForOrg,
  registerInstallationOnConnection,
} from "../../../models/github-installation.js"
import { backendOtelMiddleware } from "../../../observability/http.js"
import { registerGithubWebhookRoute } from "./github.js"

const installationId = 626_262
const ownAppInstallationId = 737_373
const deploymentSecret = "deployment-webhook-secret"
const draftSecret = "draft-webhook-secret"
function rsaPrivateKey() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey
}
const ownAppPrivateKey = rsaPrivateKey()

const spans = recordSpans()

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
useMswServer(
  http.get(
    "https://api.github.com/app/installations/:installationId",
    ({ params }) =>
      Number(params.installationId) === ownAppInstallationId
        ? HttpResponse.json({ id: ownAppInstallationId, account: null })
        : HttpResponse.json({ message: "Not Found" }, { status: 404 }),
  ),
  // Account-slug refresh after attaching; not under test here.
  http.post(
    "https://api.github.com/app/installations/:installationId/access_tokens",
    () => HttpResponse.json({ message: "Not Found" }, { status: 404 }),
  ),
  // Better Auth dashboard events when a local .env.local enables them.
  http.post(
    "https://dash.better-auth.com/*",
    () => new HttpResponse(null, { status: 204 }),
  ),
)

describe("GitHub webhooks reach only the connections they belong to (Postgres)", () => {
  let seed: SeededOrg
  const env = parseEnv({
    ...(process.env as Record<string, string | undefined>),
    // The deployment App can read every installation msw knows about.
    GITHUB_APP_ID: "2",
    GITHUB_PRIVATE_KEY: rsaPrivateKey(),
    GITHUB_WEBHOOK_SECRET: deploymentSecret,
  })

  function createApp() {
    const app = new OpenAPIHono<AppEnv>()
    app.use(contextStorage())
    app.use("*", backendOtelMiddleware())
    app.use(evlog())
    app.use("*", async (c, next) => {
      c.set("env", env)
      await next()
    })
    registerGithubWebhookRoute(app)
    return app
  }

  async function deliver(
    path: string,
    secret: string,
    event: string,
    payload: unknown,
  ) {
    const body = JSON.stringify(payload)
    return createApp().request(`http://backend.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-hub-signature-256": await new Webhooks({ secret }).sign(body),
      },
      body,
    })
  }

  function repositoryCreated(id: number) {
    return {
      action: "created",
      repository: {
        full_name: "octocat/hello-world",
        clone_url: "https://github.com/octocat/hello-world.git",
      },
      installation: { id },
    }
  }

  function createOwnAppDraft() {
    return createDraftGithubConnection({
      orgId: seed.orgId,
      env,
      githubAppId: "1",
      appSlug: "self-hosted-app",
      privateKey: ownAppPrivateKey,
      webhookSecret: draftSecret,
    })
  }

  beforeAll(async () => {
    seed = await seedOrg()
  })

  afterEach(async () => {
    for (const row of await listGithubConnectionsForOrg(seed.orgId)) {
      await deleteGithubConnectionById(seed.orgId, row.id)
    }
  })

  afterAll(async () => {
    if (seed) await cleanupSeededOrg(seed)
  })

  it("does not deliver deployment App events to a connection with its own App", async () => {
    const draft = await createOwnAppDraft()
    await registerInstallationOnConnection({
      orgId: seed.orgId,
      connectionId: draft.id,
      installationId,
      env,
    })

    const res = await deliver(
      "/api/v1/webhook/github",
      deploymentSecret,
      "repository",
      repositoryCreated(installationId),
    )

    expect(res.status).toBe(200)
    expect(spans.attributes()["ctxpipe.org.id"]).toBeUndefined()
  })

  it("delivers deployment App events to a connection using the deployment App", async () => {
    const placeholder = await createPlaceholderGithubConnection({
      orgId: seed.orgId,
    })
    await registerInstallationOnConnection({
      orgId: seed.orgId,
      connectionId: placeholder.id,
      installationId,
      env,
    })

    const res = await deliver(
      "/api/v1/webhook/github",
      deploymentSecret,
      "repository",
      repositoryCreated(installationId),
    )

    expect(res.status).toBe(200)
    expect(spans.attributes()).toMatchObject({
      "ctxpipe.org.id": seed.orgId,
      "ctxpipe.connection.id": placeholder.id,
    })
  })

  it.each([
    ["ignores an installation its own App does not own", installationId, null],
    [
      "registers an installation its own App owns",
      ownAppInstallationId,
      ownAppInstallationId,
    ],
  ])("%s from a connection's webhook", async (_, eventInstallationId, attached) => {
    const draft = await createOwnAppDraft()

    const res = await deliver(
      `/api/v1/webhook/github/${draft.id}`,
      draftSecret,
      "installation",
      { action: "created", installation: { id: eventInstallationId } },
    )

    expect(res.status).toBe(200)
    const rows = await listGithubConnectionsForOrg(seed.orgId)
    expect(rows.map((row) => row.installationId)).toEqual([attached])
  })

  it.each([
    ["installation", "created"],
    ["installation_repositories", "added"],
  ])("attaches nothing when a deployment-signed %s event is replayed to a connection on the deployment App", async (event, action) => {
    const placeholder = await createPlaceholderGithubConnection({
      orgId: seed.orgId,
    })

    const res = await deliver(
      `/api/v1/webhook/github/${placeholder.id}`,
      deploymentSecret,
      event,
      { action, installation: { id: ownAppInstallationId } },
    )

    expect(res.status).toBe(503)
    const rows = await listGithubConnectionsForOrg(seed.orgId)
    expect(rows.map((row) => row.installationId)).toEqual([null])
  })
})
