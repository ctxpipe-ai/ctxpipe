import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { WorkspaceFileTree } from "./WorkspaceFileTree"

describe("WorkspaceFileTree SSR", () => {
  it("lists file names in the first HTML", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceFileTree
        paths={["AGENTS.md", "knowledge/billing.md"]}
        selectedPath="knowledge/billing.md"
        writable={false}
        onSelect={() => {}}
      />,
    )
    expect(markup).toContain("AGENTS.md")
    expect(markup).toContain("billing.md")
  })
})
