import { afterEach, describe, expect, it, vi } from "vitest"
import { ingestionV2ShadowEnabled } from "./ingestion-v2-config.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("ingestion v2 shadow switch", () => {
  it("is off in production", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "production")
    expect(ingestionV2ShadowEnabled()).toBe(false)
  })

  it("is off for a production build with no deployment name", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "")
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "")
    vi.stubEnv("NODE_ENV", "production")
    expect(ingestionV2ShadowEnabled()).toBe(false)
  })

  it("is on in a preview deployment and in local development", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-280")
    expect(ingestionV2ShadowEnabled()).toBe(true)
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "")
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment=local-dev")
    expect(ingestionV2ShadowEnabled()).toBe(true)
  })
})
