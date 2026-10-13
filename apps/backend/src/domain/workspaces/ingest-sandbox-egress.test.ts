import type { NetworkPolicy } from "@vercel/sandbox"
import { describe, expect, it } from "vitest"
import { ingestNetworkPolicy } from "./ingest-sandbox-egress.js"
import { hostedNetworkPolicy } from "./vercel-sandbox-provider.js"

type Rule = {
  match?: { path?: { exact?: string } }
  transform?: Array<{ headers: Record<string, string> }>
  forwardURL?: string
}

const allowOf = (policy: NetworkPolicy) =>
  (policy as { allow: Record<string, Rule[]> }).allow

/** The credential the firewall adds to a request, if any. */
function credentialFor(
  policy: NetworkPolicy,
  host: string,
  path: string,
): string | undefined {
  const rules = allowOf(policy)[host] ?? []
  const rule = rules.find(
    (candidate) =>
      !candidate.match?.path || candidate.match.path.exact === path,
  )
  return rule?.transform?.[0]?.headers.authorization
}

const backendHost = "app.example.test"
const step = {
  modelProxyPath: "/acme/api/v1/workspace-chat/openai/v1",
  modelCapability: "ingest-capability",
  bridgePath: "/api/v1/workspace-chat/tool-bridge/bridge-1",
  bridgeToken: "bridge-token",
}
const git = [{ token: "git-1", repositories: ["acme/source", "acme/context"] }]
const basic = `Basic ${Buffer.from("x-access-token:git-1").toString("base64")}`

describe("ingestNetworkPolicy", () => {
  it("has no catch-all and no forward rule; the GitHub token goes only on fetch paths of the run's repositories", () => {
    const policy = ingestNetworkPolicy({ git, backendHost })
    expect(Object.keys(allowOf(policy))).toEqual(["github.com"])
    expect(
      Object.values(allowOf(policy))
        .flat()
        .some((rule) => rule.forwardURL),
    ).toBe(false)
    for (const path of [
      "/acme/source.git/info/refs",
      "/acme/source.git/git-upload-pack",
      "/acme/context.git/git-upload-pack",
    ])
      expect(credentialFor(policy, "github.com", path), path).toBe(basic)
    for (const path of [
      "/acme/context.git/git-receive-pack",
      "/acme/other.git/git-upload-pack",
      "/acme/context.git/../other.git/git-upload-pack",
    ])
      expect(credentialFor(policy, "github.com", path), path).toBeUndefined()
  })

  it("adds the step's model proxy and tool bridge credentials on exact backend paths only", () => {
    const policy = ingestNetworkPolicy({ git, backendHost, step })
    expect(allowOf(policy)["*"]).toBeUndefined()
    expect(
      credentialFor(
        policy,
        backendHost,
        `${step.modelProxyPath}/chat/completions`,
      ),
    ).toBe("Bearer ingest-capability")
    expect(credentialFor(policy, backendHost, step.bridgePath)).toBe(
      "Bearer bridge-token",
    )
    for (const path of [
      "/acme/api/v1/workspaces",
      `${step.modelProxyPath}/../../../../api/v1/x`,
    ])
      expect(credentialFor(policy, backendHost, path), path).toBeUndefined()
  })

  it("leaves the chat policy open", () => {
    const policy = hostedNetworkPolicy({ gitToken: "git-1", backendHost })
    expect(allowOf(policy)["*"]).toEqual([])
  })
})
