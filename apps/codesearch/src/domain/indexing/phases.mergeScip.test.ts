import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Db } from "../../db/client.js"
import { encodeScipIndex } from "../graph/scipProto.js"
import type { IndexPhaseRepoContext } from "./phases.js"

const trySetRepositoryIndexingStepMock = vi.hoisted(() => vi.fn())

vi.mock("../indexingSteps.js", () => ({
  trySetRepositoryIndexingStep: trySetRepositoryIndexingStepMock,
}))

import { phaseMergeScip } from "./phases.js"

describe("phaseMergeScip", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    vi.clearAllMocks()
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    )
  })

  it("omits the published index when merge throws so graph tools soft-miss", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-scip-merge-throw-"))
    temporaryDirectories.push(directory)
    const outputPath = join(directory, "index.scip")
    await writeFile(
      outputPath,
      encodeScipIndex({
        documents: [{ relativePath: "previous.ts" }],
        externalSymbols: [],
      }),
    )
    trySetRepositoryIndexingStepMock.mockRejectedValue(new Error("merge boom"))

    const ctx = {
      db: {} as Db,
      orgId: "org_mock123",
      repoId: "repo_aaaaaa",
      repoGitUrl: "https://github.com/acme/web.git",
      clonePath: directory,
      scipIndexPath: outputPath,
      zoektRepoId: 1,
      zoektName: "acme/web",
      repoName: "acme/web",
      repoUrl: "https://github.com/acme/web.git",
    } satisfies IndexPhaseRepoContext

    await expect(
      phaseMergeScip(ctx, { detectedLanguages: ["go"] }),
    ).rejects.toThrow("merge boom")

    expect(existsSync(outputPath)).toBe(false)
  })
})
