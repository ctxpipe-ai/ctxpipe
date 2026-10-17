import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { GitFilePreviewBody } from "./WorkspaceFilesPane"

const props = {
  orgSlug: "acme",
  workspaceSlug: "knowledge",
  path: "knowledge/services/tools-cli.md",
  sha: "abc123",
  editable: true,
  editorHandleRef: { current: null },
  onHistoryChange: () => {},
  onBlur: () => {},
  onChange: () => {},
}

describe("GitFilePreviewBody SSR", () => {
  it("names why a file from before Workspaces is read-only", () => {
    const reason = "This file is knowledge from before Workspaces."
    const markup = renderToStaticMarkup(
      <GitFilePreviewBody
        {...props}
        data={{
          path: props.path,
          body: "The release tools.",
          binary: false,
          readOnlyReason: reason,
        }}
      />,
    )
    const editable = renderToStaticMarkup(
      <GitFilePreviewBody
        {...props}
        data={{ path: props.path, body: "The release tools.", binary: false }}
      />,
    )
    expect(markup).toContain(reason)
    expect(editable).not.toContain(reason)
  })
})
