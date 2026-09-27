import { describe, expect, it } from "vitest"
import {
  CONNECTOR_CONTEXT_REPOSITORY_NAME,
  describeSuggestedTargetUse,
  getConnectorContextRepositoryCreateUrl,
  isCtxpipeContextRepositoryName,
} from "./ConnectorContextRepositoryGuidance"

describe("getConnectorContextRepositoryCreateUrl", () => {
  it("prefills the recommended repository name and GitHub owner", () => {
    const url = new URL(getConnectorContextRepositoryCreateUrl("acme"))

    expect(url.origin + url.pathname).toBe("https://github.com/new")
    expect(url.searchParams.get("name")).toBe(CONNECTOR_CONTEXT_REPOSITORY_NAME)
    expect(url.searchParams.get("description")).toBe(
      "Shared connector context for ctxpipe",
    )
    expect(url.searchParams.get("owner")).toBe("acme")
  })

  it("lets GitHub choose the owner when the installation is not loaded", () => {
    const url = new URL(getConnectorContextRepositoryCreateUrl())

    expect(url.searchParams.has("owner")).toBe(false)
  })
})

describe("describeSuggestedTargetUse", () => {
  it("names GitHub setup when no other connector has bound the repo", () => {
    expect(describeSuggestedTargetUse(["github"])).toBe(
      "Selected during GitHub setup.",
    )
  })

  it("lists the connectors that already use the repository", () => {
    expect(describeSuggestedTargetUse(["linear", "notion"])).toBe(
      "Already used by Linear and Notion.",
    )
  })
})

describe("isCtxpipeContextRepositoryName", () => {
  it("matches the short name or owner/name form", () => {
    expect(isCtxpipeContextRepositoryName("ctxpipe-context")).toBe(true)
    expect(isCtxpipeContextRepositoryName("acme/ctxpipe-context")).toBe(true)
    expect(isCtxpipeContextRepositoryName("acme/api")).toBe(false)
  })
})
