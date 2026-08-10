import { describe, expect, it } from "vitest"
import {
  CONNECTOR_CONTEXT_REPOSITORY_NAME,
  getConnectorContextRepositoryCreateUrl,
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
