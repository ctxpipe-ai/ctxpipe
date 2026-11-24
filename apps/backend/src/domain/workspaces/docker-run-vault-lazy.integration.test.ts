import { generateKeyPairSync } from "node:crypto"

import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import {
  cleanupSeededOrg,
  describeWithDatabase,
  type SeededOrg,
  seedOrg,
} from "../../../test/db.js"
import { useMswServer } from "../../../test/msw.js"
import { parseEnv } from "../../config/env.js"
import {
  createDraftGithubConnection,
  registerInstallationOnConnection,
} from "../../models/github-installation.js"
import { openDockerRunVault } from "./docker-run-vault.js"

const address = "http://agent-vault.test"
const installationId = 727_272
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

/** Each body that this run sent to Agent Vault, and the GitHub calls. */
const vaultBodies: string[] = []
const mints: string[] = []
const revokes: string[] = []
let mintGate: Promise<void> = Promise.resolve()

useMswServer(
  http.get("https://api.github.com/app/installations/:id", () =>
    HttpResponse.json({
      id: installationId,
      account: { login: "octocat" },
      permissions: { contents: "read" },
    }),
  ),
  http.post(
    "https://api.github.com/app/installations/:id/access_tokens",
    async () => {
      await mintGate
      const token = `ghs_lazy_${mints.length + 1}`
      mints.push(token)
      return HttpResponse.json(
        {
          token,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        { status: 201 },
      )
    },
  ),
  http.delete("https://api.github.com/installation/token", ({ request }) => {
    revokes.push(request.headers.get("authorization") ?? "")
    return new HttpResponse(null, { status: 204 })
  }),
  http.post(`${address}/v1/auth/login`, () =>
    HttpResponse.json({ token: "owner-token" }),
  ),
  http.post(`${address}/v1/vaults`, () =>
    HttpResponse.json({ name: "created" }, { status: 201 }),
  ),
  http.post(`${address}/v1/sessions`, () =>
    HttpResponse.json({
      token: "session",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      av_addr: address,
    }),
  ),
  http.get(
    `${address}/v1/mitm/ca.pem`,
    () =>
      new HttpResponse(
        "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
        { headers: { "X-MITM-Port": "14322", "X-MITM-TLS": "1" } },
      ),
  ),
  http.patch(`${address}/v1/vaults/:name/settings`, async ({ request }) =>
    HttpResponse.json(await request.json()),
  ),
  http.post(`${address}/v1/credentials`, async ({ request }) => {
    vaultBodies.push(await request.text())
    return HttpResponse.json({})
  }),
  http.all(`${address}/v1/vaults/:name/*`, async ({ request }) => {
    vaultBodies.push(await request.text())
    return HttpResponse.json({})
  }),
  http.delete(`${address}/v1/vaults/:name`, () => HttpResponse.json({})),
)

describeWithDatabase("a lazy chat vault (Postgres)", () => {
  let seed: SeededOrg
  let connectionId = ""

  beforeAll(async () => {
    vi.stubEnv("GITHUB_APP_ID", "4242")
    vi.stubEnv("GITHUB_PRIVATE_KEY", privateKey)
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret")
    seed = await seedOrg()
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const row = await createDraftGithubConnection({
      orgId: seed.orgId,
      env,
      githubAppId: "4242",
      appSlug: "ctxpipe-agent",
      privateKey,
      webhookSecret: "webhook-secret",
    })
    await registerInstallationOnConnection({
      orgId: seed.orgId,
      connectionId: row.id,
      installationId,
      env,
    })
    connectionId = row.id
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await cleanupSeededOrg(seed)
  })

  const open = () =>
    openDockerRunVault({
      orgId: seed.orgId,
      conversationId: `conv_${crypto.randomUUID().replaceAll("-", "")}`,
      label: `clone:${crypto.randomUUID()}`,
      revision: {
        workspaceId: "ws_lazy",
        remote: { url: "https://github.com/octocat/context", connectionId },
        sha: "a".repeat(40),
        generation: 1,
        defaultBranch: "main",
        access: "read",
      },
      access: {
        address,
        proxyHost: "10.0.0.1",
        ownerPassword: async () => "owner-password",
      },
      unmatchedHosts: "deny",
      workspaceRepositoryOnly: true,
      github: "lazy",
    })

  it("mints no token at open, and one on the first use", async () => {
    mints.length = 0
    vaultBodies.length = 0
    const vault = await open()
    expect(mints).toEqual([])

    await Promise.all([vault.github(), vault.github()])
    await vault.github()

    expect(mints).toEqual(["ghs_lazy_1"])
    expect(
      vaultBodies.filter((body) => body.includes("ghs_lazy_1")),
    ).toHaveLength(1)
    await vault.close()
    expect(revokes).toContain("token ghs_lazy_1")
  })

  it("revokes nothing when no command needed GitHub", async () => {
    mints.length = 0
    revokes.length = 0
    const vault = await open()
    await vault.close()
    expect(mints).toEqual([])
    expect(revokes).toEqual([])
  })

  it("revokes a token whose mint was still running when the vault closed", async () => {
    mints.length = 0
    revokes.length = 0
    let release: () => void = () => undefined
    mintGate = new Promise((resolve) => {
      release = resolve
    })
    const vault = await open()
    const minting = vault.github().catch(() => undefined)
    const closing = vault.close()
    release()
    await Promise.all([minting, closing])
    mintGate = Promise.resolve()

    expect(mints).toEqual(["ghs_lazy_1"])
    expect(revokes).toEqual(["token ghs_lazy_1"])
  })
})
