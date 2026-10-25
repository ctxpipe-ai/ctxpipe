import { afterEach, describe, expect, it, vi } from "vitest"

import {
  CODE_FORMAT,
  WORKSPACE_FORMAT_INVALID,
} from "../workspaces/workspace-format.js"
import {
  ingestionV2EnabledFor,
  ingestionV2ShadowEnabled,
  workspacePublishPipeline,
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

  it.each(["pr-280", "development", "local-dev", "local-jakub.mac"])(
    "is on in the deployment %j",
    (name) => {
      expect(inDeployment(name)).toBe(true)
    },
  )

  it("is on in a Railway preview deployment", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-280")
    expect(ingestionV2ShadowEnabled()).toBe(true)
  })

  it("is off when no deployment-environment label is set", () => {
    // The OTel name falls back to `development`; that is not a label.
    expect(inDeployment("")).toBe(false)
  })
})

describe("the Workspace format selects the ingestion", () => {
  it("is ingestion v2 from format 3 to the code format", () => {
    expect(workspacePublishPipeline(3)).toBe("v2")
    expect(workspacePublishPipeline(CODE_FORMAT)).toBe("v2")
  })

  it("is no ingestion below 3, for no file, and before the first read", () => {
    for (const format of [2, 1, 0, null])
      expect(workspacePublishPipeline(format)).toBe("none")
  })

  it("is no ingestion for an invalid format file and for a format above the code format, which are read-only", () => {
    expect(workspacePublishPipeline(WORKSPACE_FORMAT_INVALID)).toBe("none")
    expect(workspacePublishPipeline(CODE_FORMAT + 1)).toBe("none")
    expect(ingestionV2EnabledFor({ formatVersion: -1 })).toBe(false)
    expect(ingestionV2EnabledFor({ formatVersion: CODE_FORMAT + 1 })).toBe(
      false,
    )
    expect(ingestionV2EnabledFor({ formatVersion: CODE_FORMAT })).toBe(true)
  })
})
