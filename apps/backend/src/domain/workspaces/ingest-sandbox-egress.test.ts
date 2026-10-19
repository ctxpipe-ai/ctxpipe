import { randomBytes, randomUUID } from "node:crypto"
import type { NetworkPolicy } from "@vercel/sandbox"
import { afterEach, describe, expect, it, vi } from "vitest"
import { INGEST_SHARD_LIMIT_MS } from "./chat-lifecycle.js"
import { openIngestEgressScope } from "./ingest-egress-proxy.js"
import {
  hostedIngestEgressEnabled,
  INGEST_POLICY_MAX_FORWARD_URL_LENGTH,
  ingestCredentialRules,
  ingestNetworkPolicy,
  VERCEL_INGEST_EGRESS_PROVEN,
} from "./ingest-sandbox-egress.js"
import { hostedNetworkPolicy } from "./vercel-sandbox-provider.js"

type Rule = { match?: unknown; transform?: unknown; forwardURL?: string }
type Policy = {
  allow: Record<string, Rule[]>
  subnets?: { allow?: string[]; deny?: string[] }
}

const allowOf = (policy: NetworkPolicy) => (policy as Policy).allow
const random = (bytes: number) => randomBytes(bytes).toString("hex")

const secret = "egress-test-secret-0123456789abcdef"
const backendHost = "app.example.test"
const step = {
  modelProxyPath: "/acme/api/v1/workspace-chat/openai/v1",
  modelCapability: "ingest-capability",
  bridgePath: "/api/v1/workspace-chat/tool-bridge/bridge-1",
  bridgeToken: "bridge-token",
}
const git = [{ token: "git-1", repositories: ["acme/source", "acme/context"] }]

describe("ingestNetworkPolicy", () => {
  it("denies all egress until the sandbox has a name to bind the scope to", () => {
    expect(ingestNetworkPolicy({ git, backendHost, step, secret })).toBe(
      "deny-all",
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("forwards github.com and the backend host, and nothing else, to the egress proxy, each with only its part of the sealed scope", () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const policy = ingestNetworkPolicy({
      git,
      backendHost,
      step,
      secret,
      sandboxName: "sbx-ingest",
    })
    const allow = allowOf(policy)
    expect(Object.keys(allow).sort()).toEqual([backendHost, "github.com"])
    for (const rules of Object.values(allow)) {
      expect(rules).toHaveLength(1)
      expect(Object.keys(rules[0] ?? {})).toEqual(["forwardURL"])
    }
    const scopeOf = (host: string) => {
      const url = new URL(allow[host]?.[0]?.forwardURL ?? "")
      expect(url.origin).toBe(`https://${backendHost}`)
      expect(url.search).toBe("")
      return openIngestEgressScope(
        url.pathname.replace("/api/v1/sandbox-egress/", ""),
        secret,
      )
    }
    const bound = {
      sandbox: "sbx-ingest",
      exp: 1_000_000 + INGEST_SHARD_LIMIT_MS,
      backendHost,
    }
    expect(scopeOf("github.com")).toEqual({ ...bound, git })
    expect(scopeOf(backendHost)).toEqual({ ...bound, git: [], step })
    // No credential is readable in the policy.
    for (const value of ["git-1", "ingest-capability", "bridge-token"])
      expect(JSON.stringify(policy)).not.toContain(value)
  })

  it("forwards a plain git host to the egress proxy only while prepare fetches the source, never during a step (CTX-815)", () => {
    const plainGit = [{ host: "git.example.org", path: "/team/app.git" }]
    const sealedOf = (policy: NetworkPolicy, host: string) =>
      new URL(allowOf(policy)[host]?.[0]?.forwardURL ?? "").pathname.replace(
        "/api/v1/sandbox-egress/",
        "",
      )
    const prepare = ingestNetworkPolicy({
      git,
      plainGit,
      backendHost,
      secret,
      sandboxName: "sbx-ingest",
      step: { ...step, fetchSource: true },
    })
    expect(Object.keys(allowOf(prepare)).sort()).toEqual([
      backendHost,
      "git.example.org",
      "github.com",
    ])
    expect(
      openIngestEgressScope(sealedOf(prepare, "git.example.org"), secret)
        ?.plainGit,
    ).toEqual(plainGit)
    // A step, and a sandbox between steps: no plain git host, and no plain
    // git repository in the sealed scope.
    for (const policy of [
      ingestNetworkPolicy({
        git,
        plainGit,
        backendHost,
        secret,
        sandboxName: "sbx-ingest",
        step,
      }),
      ingestNetworkPolicy({
        git,
        plainGit,
        backendHost,
        secret,
        sandboxName: "sbx-ingest",
      }),
    ]) {
      expect(Object.keys(allowOf(policy)).sort()).toEqual([
        backendHost,
        "github.com",
      ])
      expect(
        openIngestEgressScope(sealedOf(policy, "github.com"), secret)?.plainGit,
      ).toBeUndefined()
    }
  })

  it("keeps the forward URLs of a shard with many Workspaces under the size that the Vercel API accepts (CTX-887)", () => {
    // Shaped as the product mints them: signed base64url claims. Each
    // checkout has random ids and commit SHAs, as in a real shard.
    const token = (claims: object) =>
      `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${randomBytes(32).toString("base64url")}`
    const claims = {
      version: 1,
      orgId: `org_${random(13)}`,
      orgSlug: "acme-platform-team",
      runId: randomUUID(),
      shard: 0,
      step: "discover-roots",
      lockOwner: randomUUID(),
    }
    const destinations = 8
    const checkouts = Array.from({ length: destinations + 1 }, (_, i) => {
      const sha = random(20)
      return {
        repositoryId: `repo_${random(13)}`,
        checkoutKey: i ? `ws:ws_${random(13)}@${sha}` : `rev:${sha}`,
        sha,
      }
    })
    const policy = ingestNetworkPolicy({
      git: [
        {
          token: `ghs_${random(18)}`,
          repositories: Array.from(
            { length: destinations + 1 },
            (_, i) => `acme-platform-team/repository-${i}-${random(4)}`,
          ),
        },
      ],
      backendHost: "backend-pr-1234.up.railway.app",
      secret,
      sandboxName: "coffee-rigid-salmon-UZAoB1",
      step: {
        modelProxyPath: `/${claims.orgSlug}/api/v1/workspace-chat/openai/v1`,
        modelCapability: token({
          ...claims,
          purpose: "workspace-ingest-model",
        }),
        bridgePath: "/api/v1/ingest/tools/mcp",
        bridgeToken: token({
          ...claims,
          purpose: "workspace-ingest-tools",
          checkouts,
        }),
      },
    })
    const length = Object.values(allowOf(policy))
      .flat()
      .reduce((sum, rule) => sum + (rule.forwardURL?.length ?? 0), 0)
    expect(length).toBeLessThanOrEqual(INGEST_POLICY_MAX_FORWARD_URL_LENGTH)
  })

  it("refuses a policy that the Vercel API would refuse, with a clear error", () => {
    expect(() =>
      ingestNetworkPolicy({
        git: [{ token: "git-1", repositories: [random(4_000)] }],
        backendHost,
        secret,
        sandboxName: "sbx-ingest",
      }),
    ).toThrow("characters of forward URLs")
  })

  it("denies private and link-local subnets", () => {
    const policy = ingestNetworkPolicy({
      git,
      backendHost,
      secret,
      sandboxName: "sbx-ingest",
    })
    expect((policy as Policy).subnets?.allow).toBeUndefined()
    expect((policy as Policy).subnets?.deny).toEqual(
      expect.arrayContaining([
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "100.64.0.0/10",
      ]),
    )
    // The Vercel API refuses an IPv6 range, and with it the whole policy.
    for (const range of (policy as Policy).subnets?.deny ?? [])
      expect(range).toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/)
  })

  it("leaves the chat policy open", () => {
    const policy = hostedNetworkPolicy({ gitToken: "git-1", backendHost })
    expect(allowOf(policy)["*"]).toEqual([])
  })
})

describe("hostedIngestEgressEnabled", () => {
  const configured = {
    VERCEL_TOKEN: "t",
    VERCEL_TEAM_ID: "egress-team",
    VERCEL_PROJECT_ID: "prj_test",
  }
  it("needs the proven flag and a configured Vercel; the team may be a slug or an id", () => {
    expect(hostedIngestEgressEnabled(configured, true)).toBe(true)
    expect(hostedIngestEgressEnabled(configured, false)).toBe(false)
    expect(hostedIngestEgressEnabled({}, true)).toBe(false)
    expect(
      hostedIngestEgressEnabled(
        { ...configured, VERCEL_TEAM_ID: "team_x" },
        true,
      ),
    ).toBe(true)
  })

  it("is open in the product after the live proof", () => {
    expect(VERCEL_INGEST_EGRESS_PROVEN).toBe(true)
  })
})

describe("ingestCredentialRules", () => {
  it("allows Git fetch of a plain git repository only for the source fetch, on port 443, with no credential, and adds the token only to GitHub (CTX-815)", () => {
    const egress = {
      repositories: [
        { fullName: "acme/context", githubConnectionId: "con_1" },
        {
          kind: "git" as const,
          host: "git.example.org",
          path: "/team/app.git",
        },
      ],
      modelProxyUrl: `https://${backendHost}/acme/api/v1/workspace-chat/openai/v1`,
      capability: "ingest-capability",
      bridge: { url: `https://${backendHost}/bridge`, token: "bridge-token" },
    }
    const access = [{ token: "git-1", repositories: ["acme/context"] }]
    const rules = ingestCredentialRules(egress, access, { fetchSource: true })
    const plain = rules.filter((rule) =>
      rule.host.startsWith("git.example.org"),
    )
    expect(
      plain.map(({ host, path, authorization }) => [host, path, authorization]),
    ).toEqual([
      ["git.example.org:443", "/team/app.git/info/refs", null],
      ["git.example.org:443", "/team/app.git/git-upload-pack", null],
    ])
    expect(
      rules
        .filter((rule) => rule.host === "github.com")
        .every((rule) => rule.authorization?.startsWith("Basic ")),
    ).toBe(true)
    // No rule allows a push or another path of the plain git host.
    expect(rules.some((rule) => rule.path?.includes("receive-pack"))).toBe(
      false,
    )
    // A step: no rule for the plain git host at all.
    expect(
      ingestCredentialRules(egress, access).some((rule) =>
        rule.host.startsWith("git.example.org"),
      ),
    ).toBe(false)
  })

  it("matches the port of a self-host plain git source: 80 for http, or its own port", () => {
    const rulesOf = (port: number) =>
      ingestCredentialRules(
        {
          repositories: [
            { kind: "git", host: "git.internal", path: "/team/app.git", port },
          ],
          modelProxyUrl: `https://${backendHost}/acme/api/v1/workspace-chat/openai/v1`,
          capability: "ingest-capability",
          bridge: { url: `https://${backendHost}/bridge`, token: "t" },
        },
        [],
        { fetchSource: true },
      )
        .filter((rule) => rule.host.startsWith("git.internal"))
        .map(({ host, path, authorization }) => [host, path, authorization])
    expect(rulesOf(80)).toEqual([
      ["git.internal:80", "/team/app.git/info/refs", null],
      ["git.internal:80", "/team/app.git/git-upload-pack", null],
    ])
    expect(rulesOf(3000).map(([host]) => host)).toEqual([
      "git.internal:3000",
      "git.internal:3000",
    ])
  })
})
