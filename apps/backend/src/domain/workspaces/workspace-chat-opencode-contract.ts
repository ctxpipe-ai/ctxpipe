import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ModelParams,
  restrictModelParamsForProvider,
} from "../../retrieval/services/modelParams.js"
import { tierModelSpecFromEnv } from "../../retrieval/services/modelTierSpecs.js"
import {
  modelParamsFromSpec,
  modelSpecBase,
} from "../../retrieval/services/parseModelSpec.js"
import type {
  ModelProviderKind,
  ModelTier,
} from "../../retrieval/services/providers/providerTypes.js"

/** Home of the Vercel sandbox user; the agent CLI and its home live under it. */
export const VERCEL_AGENT_ROOT = "/home/vercel-sandbox"

/**
 * The runtime and size of each Vercel sandbox we create. Vercel gives 2048 MB
 * of memory for each vCPU, so 1 vCPU gives 2 GB. A sandbox from a snapshot
 * keeps the runtime of that snapshot, so only the agent snapshot's builder
 * names the runtime. The agent snapshot and the Workspace bases are keyed by
 * it, so a new runtime builds them again once.
 */
export const VERCEL_SANDBOX = {
  runtime: "node26",
  resources: { vcpus: 1 },
} as const

export const WORKSPACE_CHAT_OPENCODE_PROVIDER_ID = "ctxpipe" as const

const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai/api/v1"

type WorkspaceChatOpenCodeProvider = "openai-like" | "openrouter"

function isWorkspaceChatOpenCodeProvider(
  provider: ModelProviderKind,
): provider is WorkspaceChatOpenCodeProvider {
  return provider === "openai-like" || provider === "openrouter"
}

export type WorkspaceChatOpenCodeContract =
  | {
      ok: true
      tier: ModelTier
      modelSpec: string
      modelBase: string
      opencodeModel: string
      provider: "openai-like" | "openrouter"
      upstreamBaseUrl: string
      modelParams: ModelParams | undefined
      apiKey: string
    }
  | {
      ok: false
      status: 503
      reason: "missing_provider_key" | "unsupported_provider"
      error: string
    }

function resolveProvider(raw: string | undefined): ModelProviderKind {
  const value = raw?.trim()
  if (
    value === "openai-like" ||
    value === "openrouter" ||
    value === "azure" ||
    value === "bedrock"
  ) {
    return value
  }
  return "openai-like"
}

export function workspaceChatOpenCodeModel(modelBase: string): string {
  return `${WORKSPACE_CHAT_OPENCODE_PROVIDER_ID}/${modelBase}`
}

/**
 * The backend variables that an unsandboxed agent process keeps. The agent
 * runs as the backend's OS user, so every other variable, also one added
 * later, could hold a secret.
 */
const WORKSPACE_CHAT_LOCAL_PROCESS_KEEP_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Paths of the Git configuration files and of the Git trace; no secret.
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TRACE2_EVENT",
  // The run sets these itself. The scrub runs after the run's own values
  // are added, so it must not remove them.
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_CONFIG",
])

/**
 * The variables to remove from the backend's environment before an
 * unsandboxed agent process starts: all of them except the allow-list and
 * the locale (`LC_*`). The sandbox applies this scrub after it adds the
 * run's own variables, so a run variable must not have the name of a
 * removed backend variable.
 */
export function workspaceChatLocalProcessScrubEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.keys(env).filter(
    (name) =>
      !WORKSPACE_CHAT_LOCAL_PROCESS_KEEP_ENV.has(name) &&
      !name.startsWith("LC_"),
  )
}

export const WORKSPACE_CHAT_OPENCODE_CLI = "opencode-ai@1.18.34" as const

export const WORKSPACE_CHAT_OPENCODE_PROXY_URL_ENV =
  "{env:CTXPIPE_MODEL_PROXY_URL}" as const

/**
 * What a hosted or Docker sandbox sends where a credential goes (the model
 * key, the tool-bridge token, the GitHub CLI token). The Vercel firewall or
 * Agent Vault replaces the Authorization header outside the sandbox.
 */
export const WORKSPACE_CHAT_FIREWALL_PLACEHOLDER = "ctxpipe-firewall" as const

export const WORKSPACE_CHAT_OPENCODE_JSON_SECRET =
  "CTXPIPE_OPENCODE_JSON" as const

/** Single path component under typical NAME_MAX, with room for HOME suffixes. */
export const WORKSPACE_CHAT_OPENCODE_HOME_SLUG_MAX_LENGTH = 80

const PATH_SAFE_RUNTIME_ID = /^[A-Za-z0-9_-]+$/

export function workspaceChatOpenCodeHomeSlug(conversationId: string): string {
  if (
    PATH_SAFE_RUNTIME_ID.test(conversationId) &&
    conversationId.length > 0 &&
    conversationId.length <= WORKSPACE_CHAT_OPENCODE_HOME_SLUG_MAX_LENGTH
  ) {
    return conversationId
  }
  const digest = createHash("sha256")
    .update(`${conversationId.length}:${conversationId}`, "utf8")
    .digest("hex")
    .slice(0, 32)
  const prefix = conversationId
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
  const readable = prefix.replace(/^_+|_+$/g, "").slice(0, 24) || "conversation"
  return `${readable}_${digest}`.slice(
    0,
    WORKSPACE_CHAT_OPENCODE_HOME_SLUG_MAX_LENGTH,
  )
}

export function workspaceChatOpenCodeHomeDir(conversationId: string): string {
  return join(
    tmpdir(),
    "ctxpipe-opencode-home",
    workspaceChatOpenCodeHomeSlug(conversationId),
  )
}

export function workspaceChatOpenCodeConfigPath(
  conversationId: string,
): string {
  return join(workspaceChatOpenCodeHomeDir(conversationId), "opencode.json")
}

/** Isolate local-process OpenCode from the host ~/.config/opencode + shared db. */
export function workspaceChatOpenCodeHomeEnv(
  conversationId: string,
): Record<string, string> {
  const home = workspaceChatOpenCodeHomeDir(conversationId)
  const config = join(home, "config")
  mkdirSync(config, { recursive: true })
  mkdirSync(join(home, "data"), { recursive: true })
  mkdirSync(join(home, "state"), { recursive: true })
  mkdirSync(join(home, "cache"), { recursive: true })
  return {
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    OPENCODE_CONFIG: workspaceChatOpenCodeConfigPath(conversationId),
    PATH: unixLoginPath(),
  }
}

export function writeWorkspaceChatOpenCodeConfig(input: {
  conversationId: string
  modelBase: string
  isolation?: "docker" | "unsandboxed" | "vercel"
}): { homeEnv: Record<string, string>; configJson: string } {
  const configJson = `${JSON.stringify(
    workspaceChatOpenCodeConfig({
      modelBase: input.modelBase,
      proxyAddsCredentials:
        input.isolation === "vercel" || input.isolation === "docker",
    }),
    null,
    2,
  )}\n`
  if (input.isolation && input.isolation !== "unsandboxed") {
    // Container paths belong to its nonroot user, never the backend host's
    // temporary directory or PATH. Native thread setup writes this config.
    const slug = workspaceChatOpenCodeHomeSlug(input.conversationId)
    const user = input.isolation === "vercel" ? VERCEL_AGENT_ROOT : "/home/node"
    const home = `${user}/ctxpipe-opencode/${slug}`
    return {
      configJson,
      homeEnv: {
        HOME: home,
        XDG_CONFIG_HOME: `${home}/config`,
        XDG_DATA_HOME: `${home}/data`,
        XDG_STATE_HOME: `${home}/state`,
        XDG_CACHE_HOME: `${home}/cache`,
        OPENCODE_CONFIG: `${home}/opencode.json`,
        PATH:
          input.isolation === "vercel"
            ? // The runtime image keeps Node and npm under /vercel/runtimes.
              `${VERCEL_AGENT_ROOT}/.local/bin:/vercel/runtimes/${VERCEL_SANDBOX.runtime}/bin:/usr/local/bin:/usr/bin:/bin`
            : "/usr/local/bin:/usr/bin:/bin",
      },
    }
  }
  const homeEnv = workspaceChatOpenCodeHomeEnv(input.conversationId)
  writeFileSync(
    workspaceChatOpenCodeConfigPath(input.conversationId),
    configJson,
  )
  return { homeEnv, configJson }
}

function unixLoginPath(): string {
  const extras = ["/usr/local/bin", "/usr/bin", "/bin"]
  const current = (process.env.PATH ?? "").split(":").filter(Boolean)
  return [...extras, ...current]
    .filter((dir, index, all) => all.indexOf(dir) === index)
    .join(":")
}

export const WORKSPACE_CHAT_OPENCODE_AGENT_PROMPT = [
  "You are a context advisor. Look first in knowledge units, ADRs, lessons learned, and the knowledge graph. Cite code only as evidence.",
  "Your cwd is a clone of the Workspace repository. Each Markdown file in it, connector mirrors included, is a knowledge unit, except AGENTS.md and .agents/.",
  "The GitHub sources in .ctxpipe/sources.yaml declare the linked repositories. Linked repositories are read-only and not cloned; read them with the ctxpipe tools.",
  "Each file under sources/ is one source of this Workspace. You can change a source file: your push reaches only the session branch, and a person reviews and merges the pull request. No other agent write can change sources/.",
  "Linked repositories often keep agent memory: .ai/memory/lessons-learned.md, .ai/memory/glossary.md, and ADRs, for example in .ai/memory/decisions/.",
  "Propose changes as knowledge updates, not code patches: edit or add Markdown units in this repository as the ctxpipe-knowledge skill says.",
  "The folder structure is the map of this repository. When you add, move, or delete a folder, also update the folder list in AGENTS.md.",
  "Do not add or change the generated_by and sources front matter fields. Only ctx| writes them, and a push with such a change in any commit is refused. You can remove generated_by and sources from a file to give it to people. You can change .ctxpipe/ (the Workspace sources config): it reaches the default branch only through a pull request that a person reviews and merges.",
  "Do not create .ai/memory/ in this repository. For a linked repository, write the proposed lesson, ADR, or glossary text in your answer.",
  "Prefer the smallest tool set that answers the question.",
  "Issue independent glob, grep, and read calls in one step when they do not depend on each other.",
  "Do not use subagents. Use the web only to read documentation that the task needs.",
  "After the first useful files, answer. Do not keep searching for completeness.",
  "When you change files, commit with git when a task is done, with a clear message that says why.",
  "Publish your commits with push_conversation_branch when the user should see the work on GitHub, or when they ask; never use git push.",
].join(" ")

/**
 * The model provider block of an OpenCode config: the ctxpipe model proxy,
 * and the run token or the placeholder that the firewall or Agent Vault
 * replaces. Chat and ingest use the same block.
 */
export function workspaceChatOpenCodeProvider(input: {
  modelBase: string
  proxyAddsCredentials?: boolean
}) {
  return {
    enabled_providers: ["ctxpipe"] as const,
    provider: {
      ctxpipe: {
        npm: "@ai-sdk/openai-compatible" as const,
        name: "ctxpipe" as const,
        options: {
          baseURL: WORKSPACE_CHAT_OPENCODE_PROXY_URL_ENV,
          apiKey: input.proxyAddsCredentials
            ? WORKSPACE_CHAT_FIREWALL_PLACEHOLDER
            : ("{env:CTXPIPE_OPENCODE_RUN_TOKEN}" as const),
        },
        models: {
          [input.modelBase]: { name: input.modelBase },
        },
      },
    },
    model: workspaceChatOpenCodeModel(input.modelBase),
  }
}

/**
 * Deny rules for the `bash` tool that mirror the `read` deny rules and the
 * backend permission handler's secret and metadata hard-denies (CTX-874).
 * Without them, a bash command reads what the named tools deny: an `*.env`
 * file, the OpenCode server password, a cloud-metadata endpoint, or a backend
 * secret. OpenCode matches each glob against the whole command string, so the
 * patterns use a leading and trailing wildcard to catch the token anywhere in
 * the command. `*` stays "allow" so Git and ordinary reads still run.
 */
export const WORKSPACE_CHAT_BASH_DENY: Record<string, "allow" | "deny"> = {
  "*": "allow",
  "*.env*": "deny",
  "*.env.example*": "allow",
  "*OPENCODE_SERVER_PASSWORD*": "deny",
  "*printenv*": "deny",
  "*/proc/*": "deny",
  "*169.254.169.254*": "deny",
  "*metadata.google.internal*": "deny",
  "*AUTH_SECRET*": "deny",
  "*MODEL_PROVIDER_API_KEY*": "deny",
  "*OPENAI_API_KEY*": "deny",
  "*ANTHROPIC_API_KEY*": "deny",
  "*OPENROUTER_API_KEY*": "deny",
  "*DATABASE_URL*": "deny",
}

export function workspaceChatOpenCodeConfig(input: {
  modelBase: string
  mcp?: { name: string; url: string; token: string }
  /**
   * Hosted and Docker sandboxes: the Vercel firewall or Agent Vault adds the
   * key outside the sandbox. Their network holds no credential and reaches
   * no private address but the backend, so the agent may read web pages.
   */
  proxyAddsCredentials?: boolean
}): {
  $schema: "https://opencode.ai/config.json"
  enabled_providers: readonly ["ctxpipe"]
  provider: {
    ctxpipe: {
      npm: "@ai-sdk/openai-compatible"
      name: "ctxpipe"
      options: {
        baseURL: typeof WORKSPACE_CHAT_OPENCODE_PROXY_URL_ENV
        apiKey:
          | "{env:CTXPIPE_OPENCODE_RUN_TOKEN}"
          | typeof WORKSPACE_CHAT_FIREWALL_PLACEHOLDER
      }
      models: Record<string, { name: string }>
    }
  }
  model: string
  permission: {
    task: "deny"
    webfetch: "allow" | "deny"
    websearch: "deny"
    external_directory: "deny"
    doom_loop: "deny"
    question: "deny"
    read: Record<string, "allow" | "deny">
    bash: Record<string, "allow" | "deny">
  }
  agent: {
    title: { disable: true }
    build: {
      prompt: string
    }
  }
  mcp?: Record<
    string,
    {
      type: "remote"
      url: string
      enabled: true
      headers: { Authorization: string }
    }
  >
} {
  return {
    $schema: "https://opencode.ai/config.json",
    ...workspaceChatOpenCodeProvider(input),
    // Subagents burn TTFT. Web search uses OpenCode's own search service,
    // not ours, so it stays off. A hosted or Docker agent may read web
    // pages: its network is open and holds no credential. An unsandboxed
    // agent shares the backend's network, so web reads stay off.
    //
    // OpenCode 1.18 sends an "ask" as `permission.asked`. The adapter answers
    // only the older `permission.updated`, and the UI shows no ask. Thus each
    // ask waits until the turn is cancelled (CTX-846). Each rule that OpenCode
    // sets to "ask" by default is "deny" here, so the agent gets a tool error
    // at once. A path outside the Workspace repository is not part of the
    // Workspace: the agent cannot show it to the user or push it.
    permission: {
      task: "deny",
      webfetch: input.proxyAddsCredentials ? "allow" : "deny",
      websearch: "deny",
      external_directory: "deny",
      doom_loop: "deny",
      question: "deny",
      read: {
        "*": "allow",
        "*.env": "deny",
        "*.env.*": "deny",
        "*.env.example": "allow",
      },
      // `bash` is "allow" by default, so a bash command (for example `cat
      // .env` or `echo $OPENCODE_SERVER_PASSWORD`) would read what the `read`
      // rules and the backend permission handler deny (CTX-874). The agent
      // still needs bash for Git, so bash stays allowed, but these deny rules
      // mirror the read deny and the secret rules so bash is not a bypass.
      // OpenCode matches each glob against the whole command string.
      bash: WORKSPACE_CHAT_BASH_DENY,
    },
    // Title generation is a parallel completion that contends for the same
    // model as the first user turn.
    agent: {
      title: { disable: true },
      build: {
        prompt: WORKSPACE_CHAT_OPENCODE_AGENT_PROMPT,
      },
    },
    ...(input.mcp
      ? {
          mcp: {
            [input.mcp.name]: {
              type: "remote" as const,
              url: input.mcp.url,
              enabled: true as const,
              headers: {
                Authorization: `Bearer ${input.mcp.token}`,
              },
            },
          },
        }
      : {}),
  }
}

export function workspaceChatOpenCodeContract(
  env: NodeJS.ProcessEnv = process.env,
  tier: ModelTier = "fast",
): WorkspaceChatOpenCodeContract {
  const provider = resolveProvider(env.MODEL_PROVIDER)
  if (!isWorkspaceChatOpenCodeProvider(provider)) {
    return {
      ok: false,
      status: 503,
      reason: "unsupported_provider",
      error: `Workspace chat does not support MODEL_PROVIDER=${provider}.`,
    }
  }

  const apiKey = env.MODEL_PROVIDER_API_KEY?.trim() ?? ""
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      reason: "missing_provider_key",
      error:
        "Workspace chat needs MODEL_PROVIDER_API_KEY for the configured model provider.",
    }
  }

  const modelSpec = tierModelSpecFromEnv(tier, env)
  const modelBase = modelSpecBase(modelSpec)
  const parsedParams = modelParamsFromSpec(modelSpec)
  const modelParams = restrictModelParamsForProvider(
    Object.keys(parsedParams).length > 0 ? parsedParams : undefined,
    provider,
  )
  const upstreamBaseUrl =
    env.MODEL_PROVIDER_URL?.trim() || DEFAULT_OPENROUTER_BASE

  return {
    ok: true,
    tier,
    modelSpec,
    modelBase,
    opencodeModel: workspaceChatOpenCodeModel(modelBase),
    provider,
    upstreamBaseUrl,
    modelParams,
    apiKey,
  }
}
