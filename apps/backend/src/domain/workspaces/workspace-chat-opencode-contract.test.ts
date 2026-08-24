import { afterEach, describe, expect, it } from "vitest"
import {
  WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV,
  WORKSPACE_CHAT_OPENCODE_CLI,
  workspaceChatOpenCodeConfig,
  workspaceChatOpenCodeContract,
  workspaceChatOpenCodeHomeEnv,
} from "./workspace-chat-opencode-contract.js"

describe("workspaceChatOpenCodeContract", () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
  })

  it("defaults chat to the LangChain fast spec and addresses OpenCode as ctxpipe/<base>", () => {
    const result = workspaceChatOpenCodeContract({
      MODEL_PROVIDER: "openai-like",
      MODEL_PROVIDER_API_KEY: "sk-test",
    })
    expect(result).toEqual({
      ok: true,
      tier: "fast",
      modelSpec: "openai/gpt-5.6-terra?reasoning.effort=low",
      modelBase: "openai/gpt-5.6-terra",
      opencodeModel: "ctxpipe/openai/gpt-5.6-terra",
      provider: "openai-like",
      upstreamBaseUrl: "https://openrouter.ai/api/v1",
      modelParams: { reasoning: { effort: "low" } },
      apiKey: "sk-test",
    })
  })

  it("uses MODEL_FAST_NAME when set and keeps query params on the proxy, not the OpenCode id", () => {
    const result = workspaceChatOpenCodeContract({
      MODEL_PROVIDER: "openrouter",
      MODEL_PROVIDER_API_KEY: "sk-or",
      MODEL_PROVIDER_URL: "https://openrouter.ai/api/v1",
      MODEL_FAST_NAME: "openai/gpt-5.6-terra?reasoning.effort=high",
    })
    expect(result).toMatchObject({
      ok: true,
      tier: "fast",
      modelSpec: "openai/gpt-5.6-terra?reasoning.effort=high",
      modelBase: "openai/gpt-5.6-terra",
      opencodeModel: "ctxpipe/openai/gpt-5.6-terra",
      provider: "openrouter",
      modelParams: { reasoning: { effort: "high" } },
    })
  })

  it("fails closed without MODEL_PROVIDER_API_KEY", () => {
    expect(
      workspaceChatOpenCodeContract({
        MODEL_PROVIDER: "openai-like",
      }),
    ).toEqual({
      ok: false,
      status: 503,
      reason: "missing_provider_key",
      error:
        "Workspace chat needs MODEL_PROVIDER_API_KEY for the configured model provider.",
    })
  })

  it("fails closed for azure and bedrock until a later slice", () => {
    expect(
      workspaceChatOpenCodeContract({
        MODEL_PROVIDER: "azure",
        MODEL_PROVIDER_API_KEY: "sk",
        MODEL_PROVIDER_URL: "https://example.openai.azure.com",
      }),
    ).toMatchObject({
      ok: false,
      status: 503,
      reason: "unsupported_provider",
    })
    expect(
      workspaceChatOpenCodeContract({
        MODEL_PROVIDER: "bedrock",
      }),
    ).toMatchObject({
      ok: false,
      status: 503,
      reason: "unsupported_provider",
    })
  })

  it("builds an OpenCode config that allowlists only ctxpipe", () => {
    expect(
      workspaceChatOpenCodeConfig({
        modelBase: "openai/gpt-5.6-terra",
      }),
    ).toEqual({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["ctxpipe"],
      provider: {
        ctxpipe: {
          npm: "@ai-sdk/openai-compatible",
          name: "ctxpipe",
          options: {
            baseURL: "{env:CTXPIPE_MODEL_PROXY_URL}",
            apiKey: "{env:CTXPIPE_OPENCODE_RUN_TOKEN}",
          },
          models: {
            "openai/gpt-5.6-terra": { name: "openai/gpt-5.6-terra" },
          },
        },
      },
      model: "ctxpipe/openai/gpt-5.6-terra",
      permission: {
        task: "deny",
        webfetch: "deny",
        websearch: "deny",
      },
    })
  })

  it("scrubs host provider keys and pins the OpenCode CLI", () => {
    expect(WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV).toEqual(
      expect.arrayContaining([
        "AUTH_SECRET",
        "DATABASE_URL",
        "MODEL_PROVIDER_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "GITHUB_PRIVATE_KEY",
      ]),
    )
    expect(WORKSPACE_CHAT_OPENCODE_CLI).toBe("opencode-ai@1.18.18")
  })

  it("isolates OpenCode HOME away from the host config dir", () => {
    const env = workspaceChatOpenCodeHomeEnv("conv_1")
    expect(env.HOME).toContain("ctxpipe-opencode-home")
    expect(env.HOME).toContain("conv_1")
    expect(env.HOME).not.toBe(process.env.HOME)
    expect(env.XDG_CONFIG_HOME).toBe(`${env.HOME}/config`)
    expect((env.PATH ?? "").split(":")).toEqual(
      expect.arrayContaining(["/bin", "/usr/bin"]),
    )
  })

  it("never returns a Claude or Anthropic model id", () => {
    const result = workspaceChatOpenCodeContract({
      MODEL_PROVIDER: "openai-like",
      MODEL_PROVIDER_API_KEY: "sk-test",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.opencodeModel).not.toMatch(/anthropic|claude/i)
    expect(result.modelBase).not.toMatch(/anthropic|claude/i)
  })
})
