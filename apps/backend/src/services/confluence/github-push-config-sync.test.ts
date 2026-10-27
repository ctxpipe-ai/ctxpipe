import { describe, expect, it } from "vitest"

import { connectorConfigPush } from "./github-push-config-sync.js"

const PATH = "confluence/config.yaml"
const SHAS = { before: "a".repeat(40), after: "b".repeat(40) }
const noCompare = async () => {
  throw new Error("The commit lists name the file, so no compare is needed")
}

describe("connectorConfigPush", () => {
  it("finds the config file at the repository root", async () => {
    const push = connectorConfigPush({
      commits: [{ modified: ["README.md"] }, { added: [PATH] }],
      path: PATH,
    })
    expect(push.mayTouch).toBe(true)
    expect(await push.touches("", noCompare)).toBe(true)
  })

  it("finds the config file below the Workspace root folder only", async () => {
    const push = connectorConfigPush({
      commits: [{ removed: [`docs/ctx/${PATH}`] }],
      path: PATH,
    })
    expect(push.mayTouch).toBe(true)
    expect(await push.touches("docs/ctx", noCompare)).toBe(true)
    expect(await push.touches("", noCompare)).toBe(false)
  })

  it("ignores a config file at the repository root when the Workspace has a root folder", async () => {
    const push = connectorConfigPush({
      commits: [{ modified: [PATH] }],
      path: PATH,
    })
    expect(await push.touches("docs/ctx", noCompare)).toBe(false)
  })

  it("skips a push that cannot touch the file before any lookup", () => {
    const push = connectorConfigPush({
      commits: [
        { modified: ["docs/ctx/other.yaml", "xconfluence/config.yaml"] },
      ],
      path: PATH,
    })
    expect(push.mayTouch).toBe(false)
  })

  it("asks GitHub for the file below the root folder when the commit lists do not name it", async () => {
    const push = connectorConfigPush({ commits: [], path: PATH, ...SHAS })
    expect(push.mayTouch).toBe(true)
    const asked: string[] = []
    expect(
      await push.touches("docs/ctx", async (path, base, head) => {
        asked.push(`${path}@${base}..${head}`)
        return true
      }),
    ).toBe(true)
    expect(asked).toEqual([`docs/ctx/${PATH}@${SHAS.before}..${SHAS.after}`])
  })

  it("does not compare a push that creates or deletes the branch", async () => {
    const push = connectorConfigPush({
      commits: [],
      path: PATH,
      before: "0".repeat(40),
      after: SHAS.after,
    })
    expect(push.mayTouch).toBe(false)
    expect(await push.touches("", noCompare)).toBe(false)
  })
})
