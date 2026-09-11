import { createHash } from "node:crypto"
import type {
  DockerSandboxConfig,
  DockerSandboxEgressPolicy,
} from "@tanstack/ai-sandbox-docker"

const OPENCODE_PORT = 4096
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/

export interface WorkspaceChatDockerPolicyInput {
  agentImageId: string
  proxyImageId: string
  modelBaseUrl: string
  workspaceGitUrl: string
}

export type WorkspaceChatDockerPolicy = Omit<
  DockerSandboxConfig,
  "image" | "workdir" | "publishPorts" | "isolationPolicy" | "egress"
> & {
  image: string
  workdir: string
  publishPorts: [number]
  isolationPolicy: NonNullable<DockerSandboxConfig["isolationPolicy"]>
  egress: DockerSandboxEgressPolicy
  policyIdentity: string
}

type Authority = { host: string; port: number }

function imageId(value: string, name: string): string {
  if (!IMAGE_ID.test(value))
    throw new Error(`${name} must be an immutable sha256 image ID`)
  return value
}

function parseUrl(value: string, name: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid URL`)
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(`${name} must not contain credentials, query, or fragment`)
  return parsed
}

function modelAuthority(value: string): {
  authority: Authority
  path: string
} {
  const parsed = parseUrl(value, "modelBaseUrl")
  if (parsed.protocol !== "http:")
    throw new Error("modelBaseUrl must use plain HTTP for native Docker egress")
  const path = parsed.pathname.replace(/\/+$/, "")
  return {
    authority: {
      host: parsed.hostname.toLowerCase(),
      port: parsed.port ? Number(parsed.port) : 80,
    },
    path,
  }
}

function gitAuthority(value: string): Authority {
  const parsed = parseUrl(value, "workspaceGitUrl")
  if (parsed.protocol !== "https:")
    throw new Error("workspaceGitUrl must use HTTPS in production")
  if (parsed.pathname === "/" || !parsed.pathname)
    throw new Error("workspaceGitUrl must identify a repository path")
  return {
    host: parsed.hostname.toLowerCase(),
    port: parsed.port ? Number(parsed.port) : 443,
  }
}

function sortAuthorities(authorities: Array<Authority>): Array<Authority> {
  const unique = new Map<string, Authority>()
  for (const authority of authorities)
    unique.set(`${authority.host}:${authority.port}`, authority)
  return [...unique.values()].sort(
    (left, right) =>
      left.host.localeCompare(right.host) || left.port - right.port,
  )
}

export function buildWorkspaceChatDockerPolicy(
  input: WorkspaceChatDockerPolicyInput,
): WorkspaceChatDockerPolicy {
  const agentImage = imageId(input.agentImageId, "agentImageId")
  const proxyImage = imageId(input.proxyImageId, "proxyImageId")
  const model = modelAuthority(input.modelBaseUrl)
  const git = gitAuthority(input.workspaceGitUrl)
  const modelPath = (suffix: string): string =>
    `${model.path}/${suffix}`.replace(/^\/\//, "/")
  const modelPaths = [
    modelPath("chat/completions"),
    modelPath("models"),
    modelPath("git-credentials"),
  ].sort()
  const allowConnect = sortAuthorities([
    { host: "github.com", port: 443 },
    { host: "api.github.com", port: 443 },
    git,
  ])
  const egress: DockerSandboxEgressPolicy = {
    proxyImage,
    allowConnect,
    allowHttp: [{ ...model.authority, paths: modelPaths }],
    ingress: [{ listenPort: OPENCODE_PORT, targetPort: OPENCODE_PORT }],
  }
  const isolationPolicy = {
    user: "1000:1000",
    diskSize: "4G",
    memoryBytes: 1024 ** 3,
    nanoCpus: 1_000_000_000,
    pidsLimit: 128,
  } as const
  const identity = createHash("sha256")
    .update(
      JSON.stringify({
        image: agentImage,
        proxyImage,
        workdir: "/workspace",
        publishPorts: [OPENCODE_PORT],
        isolationPolicy,
        egress,
      }),
    )
    .digest("hex")
  return {
    image: agentImage,
    workdir: "/workspace",
    publishPorts: [OPENCODE_PORT],
    isolationPolicy,
    egress,
    policyIdentity: identity,
  }
}
