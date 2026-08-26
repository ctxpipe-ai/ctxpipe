import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { WorkspaceChatChrome } from "./WorkspaceChatChrome"
import { docsWorkspace, pendingWriteWorkspace, readOnlyWorkspace } from "./workspace-fixtures"

vi.mock("@/components/OverlayNavButton", () => ({
  OverlayNavMenuButton: () => null,
}))

describe("WorkspaceChatChrome", () => {
  it("shows Read-only and pending chips, not publish actions", () => {
    const readOnly = renderToStaticMarkup(
      <WorkspaceChatChrome workspace={readOnlyWorkspace} title="Handbook">
        <p>body</p>
      </WorkspaceChatChrome>,
    )
    expect(readOnly).toContain("Read-only")
    expect(readOnly).not.toContain("Commit+Push")

    const pending = renderToStaticMarkup(
      <WorkspaceChatChrome workspace={pendingWriteWorkspace} title="Repo layout">
        <p>body</p>
      </WorkspaceChatChrome>,
    )
    expect(pending).toContain("Checking write access")
    expect(pending).not.toContain("Create PR")
  })

  it("shows Commit+Push, Creating PR, then Show PR", () => {
    const dirty = renderToStaticMarkup(
      <WorkspaceChatChrome
        workspace={docsWorkspace}
        title="Repo layout"
        branch={{ shortName: "chat/1", fullRef: "ctxpipe/chat/conv_1/1" }}
        publish={{
          commitPush: { enabled: true, pending: false, onPress: () => {} },
          pullRequest: { action: "create", pending: false, onPress: () => {} },
        }}
      >
        <p>body</p>
      </WorkspaceChatChrome>,
    )
    expect(dirty).toContain("Commit+Push")
    expect(dirty).toContain("Create PR")
    expect(dirty).toContain("chat/1")

    const creating = renderToStaticMarkup(
      <WorkspaceChatChrome
        workspace={docsWorkspace}
        title="Repo layout"
        publish={{
          commitPush: { enabled: true, pending: false, onPress: () => {} },
          pullRequest: { action: "create", pending: true, onPress: () => {} },
        }}
      >
        <p>body</p>
      </WorkspaceChatChrome>,
    )
    expect(creating).toContain("Creating PR…")

    const show = renderToStaticMarkup(
      <WorkspaceChatChrome
        workspace={docsWorkspace}
        title="Repo layout"
        publish={{
          commitPush: { enabled: true, pending: false, onPress: () => {} },
          pullRequest: {
            action: "show",
            pending: false,
            href: "https://github.com/acme/docs/pull/41",
            onPress: () => {},
          },
        }}
      >
        <p>body</p>
      </WorkspaceChatChrome>,
    )
    expect(show).toContain("Show PR")
    expect(show).not.toContain("Create PR")
  })
})
