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
 * OpenCode settings that make its first model call of a turn come sooner.
 * Each turn starts a new OpenCode server, so its start work is on the path
 * of every answer. The chat reads the repository with tools and needs no
 * live index of it: no file watcher and no file search index (the glob and
 * grep tools work without them). Measured with OpenCode 1.18.34 (CTX-848),
 * these two and `snapshot: false` cut the time from the prompt to the first
 * model call by about half.
 */
export const WORKSPACE_CHAT_OPENCODE_START_ENV = {
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
  OPENCODE_DISABLE_FFF: "1",
} as const

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
  ...Object.keys(WORKSPACE_CHAT_OPENCODE_START_ENV),
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
 * What a Docker or AgentCore sandbox sends where a credential goes (the
 * model key, the tool-bridge token, the GitHub CLI token). Agent Vault
 * replaces the Authorization header outside the sandbox.
 */
export const WORKSPACE_CHAT_CREDENTIAL_PLACEHOLDER = "ctxpipe-firewall" as const

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
    ...WORKSPACE_CHAT_OPENCODE_START_ENV,
    PATH: unixLoginPath(),
  }
}

export function writeWorkspaceChatOpenCodeConfig(input: {
  conversationId: string
  modelBase: string
  isolation?: "docker" | "unsandboxed" | "agentcore"
}): { homeEnv: Record<string, string>; configJson: string } {
  const configJson = `${JSON.stringify(
    workspaceChatOpenCodeConfig({
      modelBase: input.modelBase,
      proxyAddsCredentials:
        input.isolation === "docker" || input.isolation === "agentcore",
    }),
    null,
    2,
  )}\n`
  if (input.isolation && input.isolation !== "unsandboxed") {
    // Container paths belong to its nonroot user, never the backend host's
    // temporary directory or PATH. Native thread setup writes this config.
    const slug = workspaceChatOpenCodeHomeSlug(input.conversationId)
    const home = `/home/node/ctxpipe-opencode/${slug}`
    return {
      configJson,
      homeEnv: {
        HOME: home,
        XDG_CONFIG_HOME: `${home}/config`,
        XDG_DATA_HOME: `${home}/data`,
        XDG_STATE_HOME: `${home}/state`,
        XDG_CACHE_HOME: `${home}/cache`,
        OPENCODE_CONFIG: `${home}/opencode.json`,
        ...WORKSPACE_CHAT_OPENCODE_START_ENV,
        PATH: "/usr/local/bin:/usr/bin:/bin",
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
  "Do not add or change the generated_by and sources front matter fields. Only ctxpipe writes them, and a push with such a change in any commit is refused. You can remove generated_by and sources from a file to give it to people. You can change .ctxpipe/ (the Workspace sources config): it reaches the default branch only through a pull request that a person reviews and merges.",
  "Do not create .ai/memory/ in this repository. For a linked repository, write the proposed lesson, ADR, or glossary text in your answer.",
  'Link a Workspace file in your answer as a plain repository-relative path, for example [knowledge/x.md](knowledge/x.md). Do not add a line anchor or a file: URL to the link. Write a line in the text, for example "line 12".',
  "Prefer the smallest tool set that answers the question.",
  "Issue independent glob, grep, and read calls in one step when they do not depend on each other.",
  "Do not use subagents. Use the web only to read documentation that the task needs.",
  "After the first useful files, answer. Do not keep searching for completeness.",
  "When you change files, commit with git when a task is done, with a clear message that says why.",
  "Publish your commits with push_conversation_branch when the user should see the work on GitHub, or when they ask; never use git push.",
].join(" ")

/**
 * The model provider block of an OpenCode config: the ctxpipe model proxy,
 * and the run token or the placeholder that Agent Vault replaces. Chat and
 * ingest use the same block.
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
            ? WORKSPACE_CHAT_CREDENTIAL_PLACEHOLDER
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

export function workspaceChatOpenCodeConfig(input: {
  modelBase: string
  mcp?: { name: string; url: string; token: string }
  /**
   * Docker and AgentCore sandboxes: Agent Vault adds the key outside the
   * sandbox, and their network holds no credential. A Docker sandbox
   * reaches no private address but the backend, so its agent may read web
   * pages. An AgentCore sandbox has a closed network: its vault refuses
   * each host that no rule names, so a web read fails there.
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
          | typeof WORKSPACE_CHAT_CREDENTIAL_PLACEHOLDER
      }
      models: Record<string, { name: string }>
    }
  }
  model: string
  snapshot: false
  permission: {
    task: "deny"
    webfetch: "allow" | "deny"
    websearch: "deny"
    question: "deny"
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
    // OpenCode's undo copy of the repository. The chat never uses it; each
    // turn records its changes with Git (`snapshotConversationTurn`).
    snapshot: false,
    // Subagents burn TTFT. Web search uses OpenCode's own search service,
    // not ours, so it stays off. A Docker agent may read web pages: its
    // network holds no credential. On AgentCore the tool is on too, but the
    // closed network refuses each other host. An unsandboxed agent shares
    // the backend's network, so web reads stay off.
    //
    // OpenCode's default "ask" rules stay: doom_loop, a path outside the
    // Workspace repository (external_directory), and a read of a .env file.
    // The adapter sends each ask to the chat permission handler: hard denies,
    // then acceptEdits, then the judge. The handler hard-denies a path
    // outside the repository and a .env read. The question tool waits for an
    // answer from the user, and a chat turn has no way to send one, so it is
    // "deny".
    permission: {
      task: "deny",
      webfetch: input.proxyAddsCredentials ? "allow" : "deny",
      websearch: "deny",
      question: "deny",
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
