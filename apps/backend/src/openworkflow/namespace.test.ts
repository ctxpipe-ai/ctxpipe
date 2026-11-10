import { describe, expect, it } from "vitest"

import { openWorkflowNamespaceId } from "./namespace.js"

describe("openWorkflowNamespaceId", () => {
  it("preserves the existing default namespace when unset", () => {
    expect(openWorkflowNamespaceId({})).toBe("default")
  })

  it("isolates an explicitly configured preview namespace", () => {
    expect(
      openWorkflowNamespaceId({
        OPENWORKFLOW_NAMESPACE_ID: " preview-pr-298 ",
      }),
    ).toBe("preview-pr-298")
  })

  it("isolates a preview whose variables are copied from production", () => {
    expect(
      openWorkflowNamespaceId({
        DEPLOYMENT_ENVIRONMENT: "pr-298",
        OPENWORKFLOW_NAMESPACE_ID: "default",
      }),
    ).toBe("preview-pr-298")
  })

  it("isolates a Railway preview that copied DEPLOYMENT_ENVIRONMENT=production", () => {
    expect(
      openWorkflowNamespaceId({
        DEPLOYMENT_ENVIRONMENT: "production",
        RAILWAY_ENVIRONMENT_NAME: "pr-298",
        OPENWORKFLOW_NAMESPACE_ID: "default",
      }),
    ).toBe("preview-pr-298")
  })

  it("keeps the production namespace in production", () => {
    expect(
      openWorkflowNamespaceId({
        DEPLOYMENT_ENVIRONMENT: "production",
        OPENWORKFLOW_NAMESPACE_ID: "default",
      }),
    ).toBe("default")
  })

  it("isolates a duplicated Railway PR environment before variables are rewritten", () => {
    expect(
      openWorkflowNamespaceId({
        RAILWAY_ENVIRONMENT_NAME: "pr-298",
        OPENWORKFLOW_NAMESPACE_ID: "default",
      }),
    ).toBe("preview-pr-298")
  })
})
