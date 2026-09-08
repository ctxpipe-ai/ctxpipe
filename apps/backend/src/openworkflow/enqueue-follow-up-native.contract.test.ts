import { expect, it } from "vitest"
import { withOrgDbContext } from "../db/client.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import { getRepositoryForOrg } from "../models/repositories.js"
import { createLogger, withLogger } from "../observability/logger.js"
import { withNativeIndexFixture } from "../test/native-index-fixture.js"
import { withCanceledNativeInsert } from "../test/native-workflow-insert-failure.js"
import { enqueueFollowUpIfTipAhead } from "./enqueue-follow-up-if-tip-ahead.js"

it(
  "retries failed follow-up admission against the real source tip and reuses its native owner",
  { timeout: 30_000 },
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
      await withLogger(createLogger({ test: "native-follow-up" }), async () => {
        const input = {
          orgId: f.org.id,
          repositoryId: f.repositoryId,
          ingestedHash: "0".repeat(40),
          targetBranch: "trunk",
          requestId: "completed-request",
        }
        const errors: Error[] = []
        const logger = { error: (error: Error) => errors.push(error) }
        await expect(
          withCanceledNativeInsert(f.databaseUrl, () =>
            enqueueFollowUpIfTipAhead(input, logger),
          ),
        ).rejects.toThrow()
        expect(errors).toHaveLength(1)
        const first = await enqueueFollowUpIfTipAhead(input, logger)
        expect(first).toMatchObject({
          enqueued: true,
          tipHash: f.sha,
          workflowRunId: expect.any(String),
        })
        expect(await enqueueFollowUpIfTipAhead(input, logger)).toEqual(first)
        expect(
          await getRepositoryForOrg(f.org.id, f.repositoryId),
        ).toMatchObject({ indexingStatus: "queued" })
        expect(
          await enqueueFollowUpIfTipAhead(
            { ...input, ingestedHash: f.sha },
            logger,
          ),
        ).toEqual({ enqueued: false, tipHash: f.sha })
      })
    }, false)
  },
)
