import { describe, expect, it } from "vitest"

import {
  deploymentEnvironment,
  isPreviewDeployment,
} from "./deployment-environment.js"

describe("deploymentEnvironment", () => {
  it("reads DEPLOYMENT_ENVIRONMENT before the Railway fallback", () => {
    expect(
      deploymentEnvironment({
        DEPLOYMENT_ENVIRONMENT: " pr-12 ",
        RAILWAY_ENVIRONMENT_NAME: "production",
      }),
    ).toBe("pr-12")
  })

  it("falls back to RAILWAY_ENVIRONMENT_NAME", () => {
    expect(
      deploymentEnvironment({
        DEPLOYMENT_ENVIRONMENT: " ",
        RAILWAY_ENVIRONMENT_NAME: "pr-3",
      }),
    ).toBe("pr-3")
  })

  it("is undefined when neither is set", () => {
    expect(deploymentEnvironment({})).toBeUndefined()
  })
})

describe("isPreviewDeployment", () => {
  it("matches preview names only", () => {
    expect(isPreviewDeployment({ DEPLOYMENT_ENVIRONMENT: "pr-334" })).toBe(true)
    expect(isPreviewDeployment({ RAILWAY_ENVIRONMENT_NAME: "pr-1" })).toBe(true)
    expect(isPreviewDeployment({ DEPLOYMENT_ENVIRONMENT: "production" })).toBe(
      false,
    )
    expect(isPreviewDeployment({ DEPLOYMENT_ENVIRONMENT: "pr-env" })).toBe(
      false,
    )
    expect(isPreviewDeployment({ DEPLOYMENT_ENVIRONMENT: "local-ann" })).toBe(
      false,
    )
    expect(isPreviewDeployment({})).toBe(false)
  })
})
