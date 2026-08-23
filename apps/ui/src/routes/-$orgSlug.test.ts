import { describe, expect, it } from "vitest"
import { isWorkspaceConversationDocument } from "@/features/workspaces/ensure-route-data"

describe("isWorkspaceConversationDocument", () => {
  it("treats a conversation URL as the stored-thread document", () => {
    expect(
      isWorkspaceConversationDocument(
        "/jakub-riedl-phw/ws/context/conv_agqcxxv4gb3abdn46ruf3f42xe",
      ),
    ).toBe(true)
  })

  it("does not treat compose or other org pages as that document", () => {
    expect(isWorkspaceConversationDocument("/acme/ws/context")).toBe(false)
    expect(isWorkspaceConversationDocument("/acme")).toBe(false)
  })
})
