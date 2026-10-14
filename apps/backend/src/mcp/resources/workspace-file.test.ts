import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js"
import { describe, expect, it } from "vitest"
import {
  WORKSPACE_FILE_URI_TEMPLATE,
  workspaceFileUri,
} from "./workspace-file.js"

describe("workspaceFileUri", () => {
  const template = new UriTemplate(WORKSPACE_FILE_URI_TEMPLATE)

  it.each([
    "knowledge/services/api.md",
    "owner/name:src/index.ts",
    "slack/threads/c1:1728.md",
    "knowledge/a b#c.md",
  ])("builds a URI that the template reads back for %s", (ref) => {
    const uri = workspaceFileUri("acme", "payments", ref)
    const variables = template.match(uri)
    expect(variables?.org).toBe("acme")
    expect(variables?.workspace).toBe("payments")
    expect(decodeURIComponent(String(variables?.ref))).toBe(ref)
  })

  it("keeps a colon and a slash readable", () => {
    expect(workspaceFileUri("acme", "payments", "owner/name:src/a.ts")).toBe(
      "ctxpipe://acme/payments/owner/name:src/a.ts",
    )
  })
})
