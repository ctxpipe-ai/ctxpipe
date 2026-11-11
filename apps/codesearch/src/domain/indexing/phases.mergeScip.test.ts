import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { Db } from "../../db/client.js"
import { startS3Server } from "../../test/s3Server.js"
import { encodeScipIndex } from "../graph/scipProto.js"
import { ensureScipIndex, uploadScipIndex } from "../store/scipStore.js"
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
      checkoutKey: "default",
      clonePath: directory,
      sharedClonePath: `${directory}-shared.git`,
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

  describe("with a shard store", () => {
    let server: Awaited<ReturnType<typeof startS3Server>>
    beforeAll(async () => {
      server = await startS3Server()
    })
    afterAll(async () => {
      await server?.stop()
    })
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it("leaves no older index in S3 for a graph read to fetch when the merge throws", async () => {
      server.stubEnv("prod")
      const directory = await mkdtemp(join(tmpdir(), "ctxpipe-scip-merge-s3-"))
      temporaryDirectories.push(directory)
      const outputPath = join(directory, "index.scip")
      const checkout = {
        orgId: "org_mock123",
        repoId: "repo_bbbbbb",
        checkoutKey: "default",
      }
      await writeFile(outputPath, "older index")
      await uploadScipIndex(checkout, outputPath)
      trySetRepositoryIndexingStepMock.mockRejectedValue(
        new Error("merge boom"),
      )

      await expect(
        phaseMergeScip(
          {
            db: {} as Db,
            ...checkout,
            repoGitUrl: "https://github.com/acme/api.git",
            clonePath: directory,
            sharedClonePath: `${directory}-shared.git`,
            scipIndexPath: outputPath,
            zoektRepoId: 2,
            zoektName: "acme/api",
            repoName: "acme/api",
            repoUrl: "https://github.com/acme/api.git",
          },
          { detectedLanguages: ["go"] },
        ),
      ).rejects.toThrow("merge boom")
      await ensureScipIndex(checkout, outputPath)

      expect(existsSync(outputPath)).toBe(false)
    })
  })
})
