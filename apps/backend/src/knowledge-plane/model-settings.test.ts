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

it("logs nothing when the model settings reach OpenRouter", () => {
  vi.stubEnv("MODEL_PROVIDER", "openrouter")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  expect(checkKnowledgePlaneModelSettings()).toBe(true)
  expect(events).toEqual([])
})

it.each([
  ["bedrock", { MODEL_PROVIDER: "bedrock", MODEL_PROVIDER_API_KEY: "" }],
  ["azure", { MODEL_PROVIDER: "azure", MODEL_PROVIDER_API_KEY: "test-key" }],
  ["no key", { MODEL_PROVIDER: "openrouter", MODEL_PROVIDER_API_KEY: "" }],
])("logs one error with %s, and no key in it", (_name, env) => {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  expect(checkKnowledgePlaneModelSettings()).toBe(false)
  expect(events).toEqual([
    expect.objectContaining({
      level: "error",
      step: "knowledge_plane.model_settings",
    }),
  ])
  expect(JSON.stringify(events)).not.toContain("test-key")
})
