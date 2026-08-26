import { describe, expect, it } from "vitest"
import {
  conversationWriteToolPaths,
  conversationWriteToolSignature,
} from "./conversationFileLive"

describe("conversationWriteToolPaths", () => {
  it("collects write and edit tool paths", () => {
    expect(
      conversationWriteToolPaths([
        {
          parts: [
            {
              type: "tool-call",
              name: "write",
              input: { path: "knowledge/billing/ledger.md" },
            },
            {
              type: "tool-call",
              name: "hybrid_search",
              input: { query: "billing" },
            },
            {
              type: "tool-call",
              name: "edit",
              input: { filePath: "AGENTS.md" },
            },
          ],
        },
      ]),
    ).toEqual(["knowledge/billing/ledger.md", "AGENTS.md"])
  })

  it("fingerprints the write set", () => {
    expect(
      conversationWriteToolSignature([
        {
          parts: [
            {
              type: "tool-call",
              name: "apply_patch",
              input: { path: "README.md" },
            },
          ],
        },
      ]),
    ).toBe("README.md")
  })
})
