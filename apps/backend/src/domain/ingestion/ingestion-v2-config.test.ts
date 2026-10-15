import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ingestionPublishPipeline,
  ingestionV2ShadowEnabled,
  publishPipelineStopped,
} from "./ingestion-v2-config.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

function inDeployment(name: string): boolean {
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "")
  vi.stubEnv("NODE_ENV", "test")
  vi.stubEnv(
    "OTEL_RESOURCE_ATTRIBUTES",
    name ? `deployment.environment=${name}` : "",
  )
  return ingestionV2ShadowEnabled()
}

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

  it.each([
    "prod",
    "Production",
    "staging",
    "observability",
    "pr-",
    "local-",
    "pr",
    "my-pr-280",
    "development-old",
  ])("is off in the deployment %j, which is not in the allowlist", (name) => {
    expect(inDeployment(name)).toBe(false)
  })

  it.each([
    "pr-280",
    "development",
    "local-dev",
    "local-jakub.mac",
  ])("is on in the deployment %j", (name) => {
    expect(inDeployment(name)).toBe(true)
  })

  it("is on in a Railway preview deployment", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-280")
    expect(ingestionV2ShadowEnabled()).toBe(true)
  })

  it("is off when no deployment-environment label is set", () => {
    // The OTel name falls back to `development`; that is not a label.
    expect(inDeployment("")).toBe(false)
  })
})

describe("ingestion publish pipeline switch", () => {
  // The switch to v2 waits for the unlink retraction (CTX-720) and the
  // phase 4 checks (CTX-639).
  it("is the old pipeline until the switch to ingestion v2", () => {
    expect(ingestionPublishPipeline()).toBe("legacy")
  })
})

describe("publish pipeline stop at push time", () => {
  it("lets a job push while its pipeline is the queued and the committed one", () => {
    for (const pipeline of ["legacy", "v2"] as const)
      expect(
        publishPipelineStopped({
          job: pipeline,
          queued: pipeline,
          committed: pipeline,
        }),
      ).toBe(false)
  })

  it("stops a job that was queued before a switch", () => {
    expect(
      publishPipelineStopped({
        job: "legacy",
        queued: "legacy",
        committed: "v2",
      }),
    ).toBe(true)
    expect(
      publishPipelineStopped({ job: "v2", queued: "v2", committed: "legacy" }),
    ).toBe(true)
  })

  it("stops a job of the pipeline that was not queued", () => {
    expect(
      publishPipelineStopped({ job: "v2", queued: "legacy", committed: "v2" }),
    ).toBe(true)
  })
})
