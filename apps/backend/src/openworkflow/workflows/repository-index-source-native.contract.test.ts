import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import { fetchFiles } from "../../domain/codeIngestion/codesearchClient.js"
import { withIngestAgentContext } from "../../graphs/codeIngestionGraph/withIngestAgentContext.js"
import {
  getRepositoryForOrg,
  markRepositoryIndexingReady,
} from "../../models/repositories.js"
import { codeSearch } from "../../retrieval/services/codeSearch.js"
import { withNativeIndexFixture } from "../../test/native-index-fixture.js"
import { getFileTool } from "../../tools/getFile.js"
import { searchTool } from "../../tools/search.js"
import { repositoryIndex } from "./repository-index.js"

it(
  "keeps the published source files and search when an older index finishes last",
  { timeout: 45_000 },
  async () => {
    await withNativeIndexFixture(async (f) => {
      await withOrgDbContext(f.org.id, (db) =>
        db.insert(repositoryCheckouts).values({
          id: `co_${f.namespace}`,
          orgId: f.org.id,
          repositoryId: f.repositoryId,
          ref: "trunk",
          checkoutKey: "default",
        }),
      )
      const index = async (targetHash: string) => {
        const handle = await f.runner.runWorkflow(repositoryIndex.spec, {
          orgId: f.org.id,
          repositoryId: f.repositoryId,
          targetHash,
        })
        expect(await handle.result({ timeoutMs: 15_000 })).toMatchObject({
          targetHash,
          searchIndexOk: true,
        })
      }
      await index(f.sha)
      await writeFile(
        join(f.remote, "AGENTS.md"),
        "# New published source\nUse cobaltcedar instructions.\n",
      )
      f.git("add", "AGENTS.md")
      f.git(
        "-c",
        "user.name=Contract",
        "-c",
        "user.email=contract@example.test",
        "commit",
        "-m",
        "Publish newer source",
      )
      const newer = f.git("rev-parse", "HEAD")
      await index(newer)
      await withOrgDbContext(f.org.id, () =>
        markRepositoryIndexingReady({
          repositoryId: f.repositoryId,
          targetHash: newer,
        }),
      )
      await index(f.sha)
      expect(await getRepositoryForOrg(f.org.id, f.repositoryId)).toMatchObject(
        { indexingStatus: "ready", indexingStepKey: null },
      )
      expect(await fetchFiles(f.repositoryId, f.org.id, ["AGENTS.md"])).toEqual(
        {
          "AGENTS.md":
            "# New published source\nUse cobaltcedar instructions.\n",
        },
      )
      const results = await codeSearch(f.org.id, {
        repositoryIds: [f.repositoryId],
        query: "cobaltcedar",
      })
      expect(results[0]?.response.Files).toMatchObject([
        { FileName: "AGENTS.md", Version: newer },
      ])
      await withOrgIdContext(f.org, () =>
        withIngestAgentContext(
          {
            sessionId: f.namespace,
            source: {
              orgId: f.org.id,
              repositoryId: f.repositoryId,
              sha: f.sha,
            },
          },
          async () => {
            expect(
              await getFileTool.invoke({
                repositoryId: f.repositoryId,
                path: "AGENTS.md",
              }),
            ).toContain("amberquartz")
            expect(
              await searchTool.invoke({
                repositoryId: f.repositoryId,
                query: "amberquartz",
              }),
            ).toContain("AGENTS.md")
          },
        ),
      )
      expect(
        await withOrgIdContext(f.org, () =>
          getFileTool.invoke({
            repositoryId: f.repositoryId,
            path: "AGENTS.md",
          }),
        ),
      ).toContain("cobaltcedar")
    }, false)
  },
)
