import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  conversationPaneSessionKey,
  conversationPaneSnapshot,
  readConversationPaneSession,
  resolveConversationChrome,
  writeConversationPaneSession,
} from "./conversationPaneSession"

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear() {
      data.clear()
    },
    getItem(key) {
      return data.get(key) ?? null
    },
    key(index) {
      return [...data.keys()][index] ?? null
    },
    removeItem(key) {
      data.delete(key)
    },
    setItem(key, value) {
      data.set(key, String(value))
    },
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: memoryStorage(),
  })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, "sessionStorage")
})

describe("conversationPaneSession", () => {
  it("round-trips a snapshot in sessionStorage", () => {
    const snapshot = conversationPaneSnapshot({
      pane: { kind: "file", path: "knowledge/billing/ledger.md" },
      collapsed: false,
      tabs: {
        tabs: ["knowledge/billing/ledger.md"],
        previewPath: "knowledge/billing/ledger.md",
      },
    })
    writeConversationPaneSession("acme", "docs", "conv_1", snapshot)
    expect(readConversationPaneSession("acme", "docs", "conv_1")).toEqual(
      snapshot,
    )
    expect(conversationPaneSessionKey("acme", "docs", "conv_1")).toBe(
      "ctxpipe:ws-pane:acme:docs:conv_1",
    )
  })

  it("returns null when nothing is stored or the payload is invalid", () => {
    expect(readConversationPaneSession("acme", "docs", "conv_1")).toBeNull()
    sessionStorage.setItem(
      conversationPaneSessionKey("acme", "docs", "conv_1"),
      "{",
    )
    expect(readConversationPaneSession("acme", "docs", "conv_1")).toBeNull()
    sessionStorage.setItem(
      conversationPaneSessionKey("acme", "docs", "conv_1"),
      JSON.stringify({ pane: "files" }),
    )
    expect(readConversationPaneSession("acme", "docs", "conv_1")).toBeNull()
  })
})

describe("resolveConversationChrome", () => {
  it("keeps an explicit URL pane open", () => {
    expect(
      resolveConversationChrome({
        paneParam: "graph",
        conversationId: "conv_1",
        stored: null,
      }),
    ).toEqual({
      pane: { kind: "graph" },
      collapsed: false,
      tabs: { tabs: [], previewPath: null },
    })
  })

  it("defaults compose and unrestored conversations to chat only", () => {
    const chatOnly = {
      pane: { kind: "files" },
      collapsed: true,
      tabs: { tabs: [], previewPath: null },
    }
    expect(
      resolveConversationChrome({
        paneParam: undefined,
        stored: {
          pane: "files",
          collapsed: false,
          tabs: ["README.md"],
          previewPath: null,
        },
      }),
    ).toEqual(chatOnly)
    expect(
      resolveConversationChrome({
        paneParam: undefined,
        conversationId: "conv_1",
        stored: null,
      }),
    ).toEqual(chatOnly)
  })

  it("restores the last open pane and tabs for a conversation", () => {
    expect(
      resolveConversationChrome({
        paneParam: undefined,
        conversationId: "conv_1",
        stored: {
          pane: "file:AGENTS.md",
          collapsed: false,
          tabs: ["README.md", "AGENTS.md"],
          previewPath: "AGENTS.md",
        },
      }),
    ).toEqual({
      pane: { kind: "file", path: "AGENTS.md" },
      collapsed: false,
      tabs: { tabs: ["README.md", "AGENTS.md"], previewPath: "AGENTS.md" },
    })
  })

  it("keeps the last pane kind when the snapshot is collapsed", () => {
    expect(
      conversationPaneSnapshot({
        pane: { kind: "graph" },
        collapsed: true,
        tabs: { tabs: ["README.md"], previewPath: null },
      }),
    ).toEqual({
      pane: "graph",
      collapsed: true,
      tabs: ["README.md"],
      previewPath: null,
    })
  })

  it("keeps a stored collapsed conversation as chat only", () => {
    expect(
      resolveConversationChrome({
        paneParam: undefined,
        conversationId: "conv_1",
        stored: {
          pane: null,
          collapsed: true,
          tabs: ["README.md"],
          previewPath: null,
        },
      }),
    ).toEqual({
      pane: { kind: "files" },
      collapsed: true,
      tabs: { tabs: ["README.md"], previewPath: null },
    })
  })
})
