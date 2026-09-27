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

  it("isolates a duplicated Railway PR environment before variables are rewritten", () => {
    expect(
      openWorkflowNamespaceId({
        RAILWAY_ENVIRONMENT_NAME: "pr-298",
        OPENWORKFLOW_NAMESPACE_ID: "default",
      }),
    ).toBe("preview-pr-298")
  })
})
