import { HttpResponse, http } from "msw"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../../test/msw.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  listWorkspaceCheckoutPaths,
  readWorkspaceCheckoutFile,
} from "./checkout-read.js"

const requested: Array<{ paths: string[]; root?: string }> = []
useMswServer(
  http.get("http://codesearch.test/:repositoryId/tree", () =>
    HttpResponse.json({
      paths: [
        "README.md",
        "docs/context/AGENTS.md",
        "docs/context/knowledge/a.md",
        "docs/contextual/b.md",
      ],
    }),
  ),
  http.post(
    "http://codesearch.test/:repositoryId/files-query",
    async ({ request }) => {
      const body = (await request.json()) as { paths: string[]; root?: string }
      requested.push(body)
      const { paths } = body
      return HttpResponse.json(
        Object.fromEntries(
          paths.map((path) => [
            path,
            Buffer.from(`# ${path}\n`).toString("base64"),
          ]),
        ),
      )
    },
  ),
)

const org = { id: "org_rootread", slug: "root-read" }
const read = {
  workspaceId: "ws_rootread",
  repositoryId: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  sha: "a".repeat(40),
  rootPath: "docs/context",
}

describe("Workspace checkout reads with a root folder", () => {
  beforeEach(() => {
    requested.length = 0
    vi.stubEnv("CODESEARCH_URL", "http://codesearch.test")
    vi.stubEnv("AUTH_SECRET", "a".repeat(32))
    vi.stubEnv("DATABASE_URL", "postgres://unused.invalid/db")
  })

  it("lists only the paths below the root folder, relative to it", async () => {
    await expect(
      withOrgIdContext(org, () => listWorkspaceCheckoutPaths(read)),
    ).resolves.toEqual(["AGENTS.md", "knowledge/a.md"])
  })

  it("reads a root-relative path and lets codesearch keep the read below the root folder", async () => {
    // Codesearch resolves symlinks against the root folder, not the checkout.
    const file = await withOrgIdContext(org, () =>
      readWorkspaceCheckoutFile({ ...read, path: "knowledge/a.md" }),
    )
    expect(requested).toEqual([
      { paths: ["knowledge/a.md"], root: "docs/context" },
    ])
    expect(file).toMatchObject({ kind: "bytes" })
  })

  it("refuses a path that leaves the root folder", async () => {
    await expect(
      withOrgIdContext(org, () =>
        readWorkspaceCheckoutFile({ ...read, path: "../../README.md" }),
      ),
    ).rejects.toThrow()
    expect(requested).toEqual([])
  })

  it("sends no root for a Workspace at the repository root", async () => {
    await withOrgIdContext(org, () =>
      readWorkspaceCheckoutFile({ ...read, rootPath: "", path: "README.md" }),
    )
    expect(requested).toEqual([{ paths: ["README.md"] }])
  })
})
