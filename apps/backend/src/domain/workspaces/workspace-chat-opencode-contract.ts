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

const SUPPORTED_PROVIDERS = new Set<ModelProviderKind>([
  "openai-like",
  "openrouter",
])

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

export function workspaceChatOpenCodeConfig(input: {
  modelBase: string
  baseUrl: string
}): {
  $schema: "https://opencode.ai/config.json"
  enabled_providers: readonly ["ctxpipe"]
  provider: {
    ctxpipe: {
      npm: "@ai-sdk/openai-compatible"
      name: "ctxpipe"
      options: { baseURL: string; apiKey: "{env:CTXPIPE_OPENCODE_RUN_TOKEN}" }
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
          baseURL: input.baseUrl,
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
  if (!SUPPORTED_PROVIDERS.has(provider)) {
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
