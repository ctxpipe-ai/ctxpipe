import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ModelParams,
  restrictModelParamsForProvider,
} from "../../retrieval/services/modelParams.js"
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

const DEFAULT_TIER_SPECS = {
  fast: "openai/gpt-5.6-terra?reasoning.effort=low",
  medium: "openai/gpt-5.6-terra?reasoning.effort=medium",
  high: "openai/gpt-5.6-terra?reasoning.effort=high",
} as const

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

function resolveTierSpec(env: NodeJS.ProcessEnv, tier: ModelTier): string {
  const fromEnv =
    tier === "fast"
      ? env.MODEL_FAST_NAME
      : tier === "medium"
        ? env.MODEL_MEDIUM_NAME
        : env.MODEL_HIGH_NAME
  const trimmed = fromEnv?.trim()
  return trimmed || DEFAULT_TIER_SPECS[tier]
}

export function workspaceChatOpenCodeModel(modelBase: string): string {
  return `${WORKSPACE_CHAT_OPENCODE_PROVIDER_ID}/${modelBase}`
}

export const WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV = [
  "AUTH_SECRET",
  "DATABASE_URL",
  "MODEL_PROVIDER_API_KEY",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "SMTP_PASS",
  "SMTP_PASSWORD",
  "LANGSMITH_API_KEY",
  "LANGFUSE_SECRET_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AMPLITUDE_API_KEY",
] as const

export const WORKSPACE_CHAT_OPENCODE_CLI = "opencode-ai@1.18.18" as const

export const WORKSPACE_CHAT_OPENCODE_PROXY_URL_ENV =
  "{env:CTXPIPE_MODEL_PROXY_URL}" as const

/** Isolate local-process OpenCode from the host ~/.config/opencode + shared db. */
export function workspaceChatOpenCodeHomeEnv(
  conversationId: string,
): Record<string, string> {
  const slug = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_") || "conversation"
  const home = join(tmpdir(), "ctxpipe-opencode-home", slug)
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
  }
}

export function workspaceChatOpenCodeConfig(input: { modelBase: string }): {
  $schema: "https://opencode.ai/config.json"
  enabled_providers: readonly ["ctxpipe"]
  provider: {
    ctxpipe: {
      npm: "@ai-sdk/openai-compatible"
      name: "ctxpipe"
      options: {
        baseURL: typeof WORKSPACE_CHAT_OPENCODE_PROXY_URL_ENV
        apiKey: "{env:CTXPIPE_OPENCODE_RUN_TOKEN}"
      }
      models: Record<string, { name: string }>
    }
  }
  model: string
} {
  return {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["ctxpipe"],
    provider: {
      ctxpipe: {
        npm: "@ai-sdk/openai-compatible",
        name: "ctxpipe",
        options: {
          baseURL: WORKSPACE_CHAT_OPENCODE_PROXY_URL_ENV,
          apiKey: "{env:CTXPIPE_OPENCODE_RUN_TOKEN}",
        },
        models: {
          [input.modelBase]: { name: input.modelBase },
        },
      },
    },
    model: workspaceChatOpenCodeModel(input.modelBase),
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

  const modelSpec = resolveTierSpec(env, tier)
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
