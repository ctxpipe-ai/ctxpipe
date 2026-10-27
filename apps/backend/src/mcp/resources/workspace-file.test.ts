import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { orgArgument } from "../framework/tool-registry.js"
import { readFileInputShape } from "../tools/read-file.js"
import { WORKSPACE_FILE_URI_TEMPLATE } from "./workspace-file.js"

function workspaceFileUri(org: string, workspace: string, ref: string): string {
  const encoded = ref
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":"))
    .join("/")
  return `ctxpipe://${org}/${workspace}/${encoded}`
}

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

  it("rejects a resource ref longer than the read_file limit", () => {
    const variables = template.match(
      workspaceFileUri("acme", "payments", "x".repeat(2_000)),
    )
    const schema = z.object({ org: orgArgument, ...readFileInputShape })

    expect(
      schema.safeParse({
        org: variables?.org,
        workspace: variables?.workspace,
        ref: variables?.ref,
      }).success,
    ).toBe(false)
  })
})
