import { initLogger } from "evlog"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { checkKnowledgePlaneModelSettings } from "./model-settings.js"

const events: Record<string, unknown>[] = []

beforeEach(() => {
  events.length = 0
  initLogger({
    env: { service: "ctxpipe-backend", environment: "test" },
    pretty: false,
    drain: (ctx) => {
      events.push(ctx.event)
    },
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
})

it.each([
  ["openrouter", { MODEL_PROVIDER: "openrouter", MODEL_PROVIDER_URL: "" }],
  ["openai-like, default URL", { MODEL_PROVIDER: "", MODEL_PROVIDER_URL: "" }],
  [
    "openai-like, OpenRouter URL",
    {
      MODEL_PROVIDER: "openai-like",
      MODEL_PROVIDER_URL: "https://openrouter.ai/api/v1",
    },
  ],
  [
    "an allowlist with the provider of Jev",
    {
      MODEL_PROVIDER: "openrouter",
      MODEL_PROVIDER_ALLOWLIST: "azure,typesafe",
    },
  ],
])("logs nothing with %s and a key", (_name, env) => {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  checkKnowledgePlaneModelSettings()
  expect(events).toEqual([])
})

it.each([
  ["bedrock", { MODEL_PROVIDER: "bedrock", MODEL_PROVIDER_API_KEY: "" }],
  ["azure", { MODEL_PROVIDER: "azure", MODEL_PROVIDER_API_KEY: "test-key" }],
  ["no key", { MODEL_PROVIDER: "openrouter", MODEL_PROVIDER_API_KEY: "" }],
  [
    "openai-like, another API",
    {
      MODEL_PROVIDER: "openai-like",
      MODEL_PROVIDER_URL: "https://api.openai.com/v1",
      MODEL_PROVIDER_API_KEY: "test-key",
    },
  ],
  [
    "an allowlist without the provider of Jev",
    {
      MODEL_PROVIDER: "openrouter",
      MODEL_PROVIDER_API_KEY: "test-key",
      MODEL_PROVIDER_ALLOWLIST: "azure,google-vertex",
    },
  ],
])("logs one error with %s, and no key in it", (_name, env) => {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  checkKnowledgePlaneModelSettings()
  expect(events).toEqual([
    expect.objectContaining({
      level: "error",
      step: "knowledge_plane.model_settings",
    }),
  ])
  expect(JSON.stringify(events)).not.toContain("test-key")
})
