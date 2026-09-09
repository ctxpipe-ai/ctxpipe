import { describe, expect, it } from "vitest"
import { buildWorkspaceChatDockerPolicy } from "./workspace-chat-docker-policy.js"

const AGENT_IMAGE = `sha256:${"a".repeat(64)}`
const PROXY_IMAGE = `sha256:${"b".repeat(64)}`

describe("buildWorkspaceChatDockerPolicy", () => {
  it("builds the fixed native workspace and exact model/git egress policy", () => {
    const policy = buildWorkspaceChatDockerPolicy({
      agentImageId: AGENT_IMAGE,
      proxyImageId: PROXY_IMAGE,
      modelBaseUrl:
        "http://model.internal:8080/org/api/v1/workspace-chat/openai/v1/",
      workspaceGitUrl: "https://git.example.test:8443/acme/repo.git",
    })

    expect(policy).toMatchObject({
      image: AGENT_IMAGE,
      workdir: "/workspace",
      publishPorts: [4096],
      isolationPolicy: {
        user: "1000:1000",
        diskSize: "4G",
        memoryBytes: 1024 ** 3,
        nanoCpus: 1_000_000_000,
        pidsLimit: 128,
      },
      egress: {
        proxyImage: PROXY_IMAGE,
        allowConnect: [
          { host: "api.github.com", port: 443 },
          { host: "git.example.test", port: 8443 },
          { host: "github.com", port: 443 },
        ],
        allowHttp: [
          {
            host: "model.internal",
            port: 8080,
            paths: [
              "/org/api/v1/workspace-chat/openai/v1/chat/completions",
              "/org/api/v1/workspace-chat/openai/v1/git-credentials",
              "/org/api/v1/workspace-chat/openai/v1/models",
            ],
          },
        ],
        ingress: [{ listenPort: 4096, targetPort: 4096 }],
      },
    })
    expect(policy.policyIdentity).toMatch(/^[a-f0-9]{64}$/)
  })

  it("deduplicates required GitHub access and normalizes a model trailing slash", () => {
    const base = {
      agentImageId: AGENT_IMAGE,
      proxyImageId: PROXY_IMAGE,
      workspaceGitUrl: "https://github.com/acme/repo.git",
    }
    const withSlash = buildWorkspaceChatDockerPolicy({
      ...base,
      modelBaseUrl: "http://model.internal/v1/",
    })
    const withoutSlash = buildWorkspaceChatDockerPolicy({
      ...base,
      modelBaseUrl: "http://model.internal/v1",
    })

    expect(withSlash).toEqual(withoutSlash)
    expect(withSlash.egress?.allowConnect).toEqual([
      { host: "api.github.com", port: 443 },
      { host: "github.com", port: 443 },
    ])

    const rootModel = buildWorkspaceChatDockerPolicy({
      ...base,
      modelBaseUrl: "http://model.internal/",
    })
    expect(rootModel.egress?.allowHttp[0]?.paths).toEqual([
      "/chat/completions",
      "/git-credentials",
      "/models",
    ])
  })

  it("separates images and tenant destinations in the reusable policy identity", () => {
    const input = {
      agentImageId: AGENT_IMAGE,
      proxyImageId: PROXY_IMAGE,
      modelBaseUrl: "http://model.internal/org-a/v1",
      workspaceGitUrl: "https://git-a.example.test/acme/repo.git",
    }
    const initial = buildWorkspaceChatDockerPolicy(input)
    for (const changed of [
      { agentImageId: `sha256:${"c".repeat(64)}` },
      { proxyImageId: `sha256:${"c".repeat(64)}` },
      { modelBaseUrl: "http://model.internal/org-b/v1" },
      { workspaceGitUrl: "https://git-b.example.test/acme/repo.git" },
    ]) {
      expect(
        buildWorkspaceChatDockerPolicy({ ...input, ...changed }).policyIdentity,
      ).not.toBe(initial.policyIdentity)
    }
    // A repository path on an already allowed Git host does not broaden egress.
    expect(
      buildWorkspaceChatDockerPolicy({
        ...input,
        workspaceGitUrl: "https://git-a.example.test/acme/other.git",
      }).policyIdentity,
    ).toBe(initial.policyIdentity)
  })

  it.each([
    ["agentImageId", "node:22"],
    ["proxyImageId", "latest"],
    ["agentImageId", "sha256:abc"],
  ] as const)("rejects mutable %s reference %s", (field, value) => {
    expect(() =>
      buildWorkspaceChatDockerPolicy({
        agentImageId: field === "agentImageId" ? value : AGENT_IMAGE,
        proxyImageId: field === "proxyImageId" ? value : PROXY_IMAGE,
        modelBaseUrl: "http://model.internal/v1",
        workspaceGitUrl: "https://github.com/acme/repo.git",
      }),
    ).toThrow(/immutable sha256 image ID/)
  })

  it.each([
    "https://model.internal/v1",
    "http://user:pass@model.internal/v1",
    "http://model.internal/v1?secret=1",
    "http://model.internal/v1#fragment",
  ])("rejects unsafe model URL %s", (modelBaseUrl) => {
    expect(() =>
      buildWorkspaceChatDockerPolicy({
        agentImageId: AGENT_IMAGE,
        proxyImageId: PROXY_IMAGE,
        modelBaseUrl,
        workspaceGitUrl: "https://github.com/acme/repo.git",
      }),
    ).toThrow(/modelBaseUrl/)
  })

  it.each([
    "http://github.com/acme/repo.git",
    "ssh://git@github.com/acme/repo.git",
    "https://user:pass@github.com/acme/repo.git",
  ])("rejects non-production Git URL %s", (workspaceGitUrl) => {
    expect(() =>
      buildWorkspaceChatDockerPolicy({
        agentImageId: AGENT_IMAGE,
        proxyImageId: PROXY_IMAGE,
        modelBaseUrl: "http://model.internal/v1",
        workspaceGitUrl,
      }),
    ).toThrow(/workspaceGitUrl/)
  })
})
