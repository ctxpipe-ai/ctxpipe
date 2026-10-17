import type { NetworkPolicy } from "@vercel/sandbox"
import { afterEach, describe, expect, it, vi } from "vitest"
import { INGEST_SHARD_LIMIT_MS } from "./chat-lifecycle.js"
import { openIngestEgressScope } from "./ingest-egress-proxy.js"
import {
  hostedIngestEgressEnabled,
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

  it("forwards github.com and the backend host, and nothing else, to the egress proxy with a sealed scope", () => {
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
    const forwardUrls = Object.values(allow).map((rules) => {
      expect(rules).toHaveLength(1)
      expect(Object.keys(rules[0] ?? {})).toEqual(["forwardURL"])
      return rules[0]?.forwardURL ?? ""
    })
    expect(new Set(forwardUrls).size).toBe(1)
    const url = new URL(forwardUrls[0] ?? "")
    expect(url.origin).toBe(`https://${backendHost}`)
    expect(url.search).toBe("")
    const sealed = url.pathname.replace("/api/v1/sandbox-egress/", "")
    expect(openIngestEgressScope(sealed, secret)).toEqual({
      sandbox: "sbx-ingest",
      exp: 1_000_000 + INGEST_SHARD_LIMIT_MS,
      backendHost,
      git,
      step,
    })
    // No credential is readable in the policy.
    for (const value of ["git-1", "ingest-capability", "bridge-token"])
      expect(JSON.stringify(policy)).not.toContain(value)
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

  it("stays closed in the product until the live proof", () => {
    expect(VERCEL_INGEST_EGRESS_PROVEN).toBe(false)
  })
})
