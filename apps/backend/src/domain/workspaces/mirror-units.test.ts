import { initLogger } from "evlog"
import { afterEach, describe, expect, it } from "vitest"

import { referenceLinks } from "./mirror-units.js"

afterEach(() => {
  initLogger({ enabled: false })
})

describe("referenceLinks", () => {
  it("links a valid Workspace URL, and skips text that only looks like a URL with no warning", () => {
    const events: Record<string, unknown>[] = []
    initLogger({
      pretty: false,
      silent: true,
      drain: (ctx) => {
        for (const item of Array.isArray(ctx) ? ctx : [ctx])
          events.push(item.event as Record<string, unknown>)
      },
    })
    const result = referenceLinks({
      workspaceUrl: "https://github.com/example-org/context",
      resolveLink: (dir, href) => (dir ? `${dir}/${href}` : href),
      units: [
        {
          path: "knowledge/a.md",
          // `\${PORT}` is template text in the body, not a placeholder here.
          body: `See https://github.com/example-org/context/blob/main/knowledge/b.md and http://localhost:\${PORT}/x and https://<host>/path.`,
          links: [],
          attributes: {},
        },
        {
          path: "knowledge/b.md",
          body: "No links.",
          links: [],
          attributes: {},
        },
      ],
    })
    expect(result.get("knowledge/a.md")).toEqual(["workspace:knowledge/b.md"])
    expect(
      events.some(
        (event) => event.step === "workspace-hydrate.reference-links",
      ),
    ).toBe(false)
  })
})
