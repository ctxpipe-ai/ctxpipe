import { describe, expect, it } from "vitest"
import {
  buildServerInstructions,
  INSTRUCTION_RULES,
  INSTRUCTIONS_HEAD_CHARS,
  INSTRUCTIONS_MAX_CHARS,
} from "./instructions.js"

describe("buildServerInstructions", () => {
  it("puts the rules first, inside the first 512 characters", () => {
    expect(INSTRUCTION_RULES.length).toBeLessThanOrEqual(
      INSTRUCTIONS_HEAD_CHARS,
    )
    const text = buildServerInstructions([
      { slug: "acme", workspaces: ["payments", "platform"] },
    ])
    const head = text.slice(0, INSTRUCTIONS_HEAD_CHARS)
    expect(head).toContain(
      "ctxpipe serves the default branch; do not use it for your current repository",
    )
    expect(head).toContain("Call these tools in parallel where possible")
    expect(head).toContain("excludeRepositories")
    expect(head).toContain("Name one org in each call")
  })

  it("lists each org with its Workspace slugs", () => {
    const text = buildServerInstructions([
      { slug: "acme", workspaces: ["payments", "platform"] },
      { slug: "beta-labs", workspaces: ["core"] },
      { slug: "empty", workspaces: [] },
    ])
    expect(text).toContain("\n- acme: payments, platform")
    expect(text).toContain("\n- beta-labs: core")
    expect(text).toContain("\n- empty: (no Workspaces)")
    expect(text).not.toContain("more Workspaces")
  })

  it("stays under 2,048 characters and points to list_workspaces when the list is long", () => {
    const orgs = Array.from({ length: 5 }, (_, org) => ({
      slug: `org-${org}-with-a-long-slug`,
      workspaces: Array.from(
        { length: 60 },
        (_, index) => `workspace-${org}-${index}-with-a-long-name`,
      ),
    }))
    const text = buildServerInstructions(orgs)
    expect(text.length).toBeLessThan(INSTRUCTIONS_MAX_CHARS)
    expect(text).toMatch(/\[and \d+ more Workspaces: call list_workspaces\]$/)
    const shown = (text.match(/workspace-\d+-\d+-with-a-long-name/g) ?? [])
      .length
    expect(text).toContain(`[and ${300 - shown} more Workspaces`)
  })

  it("never cuts a slug in half", () => {
    const text = buildServerInstructions([
      {
        slug: "acme",
        workspaces: Array.from({ length: 400 }, (_, index) => `ws-${index}`),
      },
    ])
    const listed = text.split("\n- acme: ")[1]?.split("\n[and")[0]?.split(", ")
    expect(listed?.every((slug) => /^ws-\d+$/.test(slug))).toBe(true)
  })

  it("gives only the rules when the connection has no orgs", () => {
    expect(buildServerInstructions([])).toBe(INSTRUCTION_RULES)
  })
})
