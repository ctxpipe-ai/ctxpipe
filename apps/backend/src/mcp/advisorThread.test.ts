import { basename } from "node:path"
import { describe, expect, it } from "vitest"
import {
  WORKSPACE_CHAT_OPENCODE_HOME_SLUG_MAX_LENGTH,
  workspaceChatOpenCodeHomeDir,
  workspaceChatOpenCodeHomeSlug,
} from "../domain/workspaces/workspace-chat-opencode-contract.js"
import { mcpAdvisorThreadId, mcpClientConversationId } from "./advisorThread.js"

function thread(input: {
  conversationId: string
  currentProjectName?: string | null
  actor?:
    | { type: "org-service"; orgId: string }
    | { type: "user"; userId: string }
  orgId?: string
}) {
  return mcpAdvisorThreadId({
    orgId: input.orgId ?? "org_acme",
    actor: input.actor ?? { type: "org-service", orgId: "org_acme" },
    ...("currentProjectName" in input
      ? { currentProjectName: input.currentProjectName }
      : { currentProjectName: "billing" }),
    conversationId: input.conversationId,
  })
}

describe("mcpClientConversationId", () => {
  it("keeps a raw nonblank client id and treats blank as omitted", () => {
    expect(mcpClientConversationId("session-a")).toBe("session-a")
    expect(mcpClientConversationId("  session-a  ")).toBe("  session-a  ")
    expect(mcpClientConversationId("")).toBeUndefined()
    expect(mcpClientConversationId("   ")).toBeUndefined()
    expect(mcpClientConversationId(undefined)).toBeUndefined()
    expect(mcpClientConversationId(12)).toBeUndefined()
  })
})

describe("mcpAdvisorThreadId", () => {
  it("returns the shipped persisted id when the client conversationId repeats", () => {
    const first = thread({ conversationId: "session-replay" })
    const second = thread({ conversationId: "session-replay" })
    expect(first).toBe("org_acme_org_billing_session-replay")
    expect(first).toBe(second)
  })

  it("keeps a padded nonblank conversationId exact so legacy rows resume", () => {
    expect(thread({ conversationId: "  session-a  " })).toBe(
      "org_acme_org_billing_  session-a  ",
    )
  })

  it("keeps punctuation-distinct client ids on separate persisted threads", () => {
    const slash = thread({ conversationId: "a/b" })
    const query = thread({ conversationId: "a?b" })
    expect(slash).toBe("org_acme_org_billing_a/b")
    expect(query).toBe("org_acme_org_billing_a?b")
    expect(slash).not.toBe(query)
  })

  it("maps punctuation-distinct persisted ids to distinct bounded HOME dirs", () => {
    const slash = thread({ conversationId: "a/b" })
    const query = thread({ conversationId: "a?b" })
    const slashHome = workspaceChatOpenCodeHomeSlug(slash)
    const queryHome = workspaceChatOpenCodeHomeSlug(query)
    expect(slashHome).not.toBe(queryHome)
    expect(slashHome).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(queryHome).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(slashHome.length).toBeLessThanOrEqual(
      WORKSPACE_CHAT_OPENCODE_HOME_SLUG_MAX_LENGTH,
    )
    expect(queryHome.length).toBeLessThanOrEqual(
      WORKSPACE_CHAT_OPENCODE_HOME_SLUG_MAX_LENGTH,
    )
    expect(basename(workspaceChatOpenCodeHomeDir(slash))).toBe(slashHome)
    expect(basename(workspaceChatOpenCodeHomeDir(query))).toBe(queryHome)
  })

  it("keeps a long persisted id and bounds only the HOME slug", () => {
    const conversationId = `session/${"x".repeat(300)}?tail`
    const id = thread({ conversationId })
    expect(id).toBe(`org_acme_org_billing_${conversationId}`)
    const slug = workspaceChatOpenCodeHomeSlug(id)
    expect(slug).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(slug.length).toBeLessThanOrEqual(
      WORKSPACE_CHAT_OPENCODE_HOME_SLUG_MAX_LENGTH,
    )
    expect(slug).not.toContain("/")
    expect(slug).not.toContain("?")
  })

  it("keeps org-service and member threads apart for ordinary user ids", () => {
    const conversationId = "session-shared"
    const orgThread = thread({
      conversationId,
      actor: { type: "org-service", orgId: "org_acme" },
    })
    const memberThread = thread({
      conversationId,
      actor: { type: "user", userId: "user_1" },
    })
    expect(orgThread).toBe("org_acme_org_billing_session-shared")
    expect(memberThread).toBe("org_acme_user_1_billing_session-shared")
    expect(orgThread).not.toBe(memberThread)
  })

  it("does not silently rekey the shipped org-service actor key", () => {
    // A member whose userId is the literal "org" shares that actor key.
    // Better Auth user ids are user_*; we do not change existing rows.
    const orgService = thread({ conversationId: "session-a" })
    const userAsOrgLiteral = thread({
      conversationId: "session-a",
      actor: { type: "user", userId: "org" },
    })
    expect(orgService).toBe("org_acme_org_billing_session-a")
    expect(userAsOrgLiteral).toBe(orgService)
  })

  it("uses slugify(default) when the project name is omitted", () => {
    expect(
      thread({
        conversationId: "session-a",
        currentProjectName: undefined,
      }),
    ).toBe("org_acme_org_default_session-a")
  })
})
