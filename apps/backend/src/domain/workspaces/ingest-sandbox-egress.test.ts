import type { NetworkPolicy } from "@vercel/sandbox"
import { describe, expect, it } from "vitest"
import { ingestNetworkPolicy } from "./ingest-sandbox-egress.js"
import {
  SANDBOX_EGRESS_DENIED_PATH,
  sandboxEgressDeniedRoutes,
} from "./sandbox-egress-denied.js"
import { hostedNetworkPolicy } from "./vercel-sandbox-provider.js"

type Rule = {
  match?: { path?: { exact?: string } }
  transform?: Array<{ headers: Record<string, string> }>
  forwardURL?: string
}

const allowOf = (policy: NetworkPolicy) =>
  (policy as { allow: Record<string, Rule[]> }).allow

/**
 * What the firewall does with a request: the first rule that matches (the
 * order the T12 live check must confirm). No rule for the host: refused.
 */
function decide(
  policy: NetworkPolicy,
  host: string,
  path: string,
): "refused" | { authorization?: string } | { forwardedTo: string } {
  const rules = allowOf(policy)[host] ?? allowOf(policy)["*"]
  if (!rules) return "refused"
  const rule = rules.find(
    (candidate) =>
      !candidate.match?.path || candidate.match.path.exact === path,
  )
  if (!rule) return {}
  if (rule.forwardURL) return { forwardedTo: rule.forwardURL }
  return { authorization: rule.transform?.[0]?.headers.authorization }
}

const backendHost = "app.example.test"
const denied = {
  forwardedTo: `https://${backendHost}${SANDBOX_EGRESS_DENIED_PATH}`,
}
const step = {
  modelProxyPath: "/acme/api/v1/workspace-chat/openai/v1",
  modelCapability: "ingest-capability",
  bridgePath: "/api/v1/workspace-chat/tool-bridge/bridge-1",
  bridgeToken: "bridge-token",
}
const git = [{ token: "git-1", repositories: ["acme/source", "acme/context"] }]
const basic = `Basic ${Buffer.from("x-access-token:git-1").toString("base64")}`

describe("ingestNetworkPolicy", () => {
  it("allows Git fetch of the run's repositories and refuses a push, other repositories, other GitHub hosts, and the internet", () => {
    const policy = ingestNetworkPolicy({ git, backendHost })
    expect(allowOf(policy)["*"]).toBeUndefined()
    for (const path of [
      "/acme/source.git/info/refs",
      "/acme/source.git/git-upload-pack",
      "/acme/context.git/git-upload-pack",
    ])
      expect(decide(policy, "github.com", path), path).toEqual({
        authorization: basic,
      })
    // A push, also with the agent's own token in the URL, goes to the
    // backend's deny route; so does another repository.
    for (const path of [
      "/acme/context.git/git-receive-pack",
      "/attacker/exfil.git/git-receive-pack",
      "/attacker/exfil.git/info/refs",
      "/acme/other.git/git-upload-pack",
      "/acme/context.git/../other.git/git-upload-pack",
    ])
      expect(decide(policy, "github.com", path), path).toEqual(denied)
    for (const host of [
      "api.github.com",
      "codeload.github.com",
      "example.com",
      backendHost,
    ])
      expect(decide(policy, host, "/"), host).toBe("refused")
  })

  it("allows the step's model proxy and tool bridge on exact paths, and sends every other backend path to the deny route", () => {
    const policy = ingestNetworkPolicy({ git, backendHost, step })
    expect(allowOf(policy)["*"]).toBeUndefined()
    expect(
      decide(policy, backendHost, `${step.modelProxyPath}/chat/completions`),
    ).toEqual({ authorization: "Bearer ingest-capability" })
    expect(
      decide(policy, backendHost, `${step.modelProxyPath}/models`),
    ).toEqual({ authorization: "Bearer ingest-capability" })
    expect(decide(policy, backendHost, step.bridgePath)).toEqual({
      authorization: "Bearer bridge-token",
    })
    for (const path of [
      "/acme/api/v1/workspaces",
      "/api/v1/workspace-chat/tool-bridge/other-bridge",
      `${step.modelProxyPath}/../../../../api/v1/x`,
      "/api/auth/session",
    ])
      expect(decide(policy, backendHost, path), path).toEqual(denied)
    // The deny rule is the last rule of each host.
    for (const rules of Object.values(allowOf(policy)))
      expect(rules.at(-1)).toEqual({ forwardURL: denied.forwardedTo })
  })

  it("leaves the chat policy open", () => {
    const policy = hostedNetworkPolicy({ gitToken: "git-1", backendHost })
    expect(allowOf(policy)["*"]).toEqual([])
    expect(decide(policy, "example.com", "/")).toEqual({})
  })
})

describe("the sandbox egress deny route", () => {
  it("answers 403 for each method and subpath", async () => {
    for (const [method, path] of [
      ["GET", SANDBOX_EGRESS_DENIED_PATH],
      ["POST", SANDBOX_EGRESS_DENIED_PATH],
      [
        "POST",
        `${SANDBOX_EGRESS_DENIED_PATH}/attacker/exfil.git/git-receive-pack`,
      ],
      ["PUT", `${SANDBOX_EGRESS_DENIED_PATH}/x`],
    ] as const) {
      const res = await sandboxEgressDeniedRoutes.request(path, { method })
      expect(res.status, `${method} ${path}`).toBe(403)
    }
  })
})
