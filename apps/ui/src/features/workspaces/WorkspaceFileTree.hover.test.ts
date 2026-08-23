import { describe, expect, it, vi } from "vitest"
import { workspaceFilePathFromHoverEvent } from "./WorkspaceFileTree"

function item(path: string) {
  return {
    getAttribute(name: string) {
      return name === "data-item-path" ? path : null
    },
  }
}

describe("workspaceFilePathFromHoverEvent", () => {
  it("reads Pierre data-item-path from the composed path", () => {
    const files = new Set(["src/a.ts", "README.md"])
    expect(
      workspaceFilePathFromHoverEvent(
        { composedPath: () => [{}, item("src/a.ts")] },
        files,
      ),
    ).toBe("src/a.ts")
  })

  it("ignores directories that are not in the file set", () => {
    expect(
      workspaceFilePathFromHoverEvent(
        { composedPath: () => [item("src")] },
        new Set(["src/a.ts"]),
      ),
    ).toBeNull()
  })

  it("lets the caller start the blob query before click", () => {
    const prefetch = vi.fn()
    const path = workspaceFilePathFromHoverEvent(
      { composedPath: () => [item("knowledge/ledger.md")] },
      new Set(["knowledge/ledger.md"]),
    )
    if (path) prefetch(path)
    expect(prefetch).toHaveBeenCalledWith("knowledge/ledger.md")
  })
})
