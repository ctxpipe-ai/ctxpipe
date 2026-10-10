import { unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { captureGitPack } from "../../services/git/pack.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { pushWorkspaceCommit } from "./write-broker.js"

it.each([
  { source: "linked", field: "git" },
  { source: "linked", field: "branch" },
  { source: "linked", field: "custom" },
  { source: "linked", field: "body" },
  { source: "linked", field: "canonical path" },
  { source: "workspace", field: "custom" },
  { source: "workspace", field: "body" },
  { source: "workspace", field: "deletion" },
  { source: "workspace", field: "BOM" },
] as const)(
  "extraction publication cannot alter $source source declaration $field",
  { timeout: 30_000 },
  async ({ source, field }) => {
    const path = source === "workspace" ? "AGENTS.md" : "repositories/source.md"
    const original =
      field === "BOM"
        ? "\uFEFFOwner notes.\n"
        : "---\ngit: https://github.com/fixture/source\nbranch: main\ncustom: owner\n---\nOwner notes.\n"
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [{ path, body: original }],
      },
      async (f) => {
        await f.handle.cancel()
        const blobSha = f.git("rev-parse", `${f.sha}:${path}`)
        f.git("reset", "--hard", f.sha)
        const changed =
          field === "BOM"
            ? original.replace("\uFEFF", "")
            : field === "git"
              ? original.replace("fixture/source", "fixture/other")
              : field === "branch"
                ? original.replace("branch: main", "branch: other")
                : field === "custom"
                  ? original.replace("custom: owner", "custom: agent")
                  : field === "body"
                    ? original.replace("Owner notes.", "Agent rewrite.")
                    : original
        const changedPath =
          field === "canonical path" ? "repositories/0-source.md" : path
        if (field === "deletion") unlinkSync(join(f.directory, changedPath))
        else writeFileSync(join(f.directory, changedPath), changed)
        f.git("add", changedPath)
        f.git("commit", "-m", "Attempt to change source authority")
        const committed = await captureGitPack(
          f.directory,
          f.git("rev-parse", "HEAD"),
        )
        await expect(
          withOrgIdContext(f.org, () =>
            pushWorkspaceCommit(
              {
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                extraction: {
                  repositoryId: "repo_captured",
                  repositoryUrl:
                    source === "workspace"
                      ? f.workspaceUrl
                      : "https://github.com/fixture/source",
                  sourceSha: f.sha,
                  ...(source === "linked"
                    ? { sourceDeclaration: { path, blobSha } }
                    : {}),
                  capture: { scope: "full", extractorVersion: 1, roots: [] },
                },
              },
              { ...f.revision, access: "write-default" },
              committed,
              parseEnv(process.env),
            ),
          ),
        ).rejects.toThrow(
          /Extraction (may only update claims in|cannot remove) its source declaration/,
        )
        expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
        expect(f.tokenRequests).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              permissions: expect.objectContaining({ contents: "write" }),
            }),
          ]),
        )
      },
    )
  },
)
