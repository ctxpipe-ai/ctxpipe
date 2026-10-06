/**
 * Graph lookups of the extract phase against real Postgres, called the way
 * `repository-ingestion` calls them: inside the org id context but outside
 * `withOrgDbContext`. Each lookup must open its own org DB scope.
 *
 * Requires DATABASE_URL (apps/backend/.env.local). Skipped otherwise.
 */
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withOrgIdContext } from "../../../auth/withAuth.js"
import { closeDb, getSystemDb, initDb } from "../../../db/client.js"
import { objects } from "../../../db/schema/objects.js"
import { generateObjectId } from "../../../lib/id.js"
import {
  listLinearTeamKeys,
  listPackageRootsForRepository,
  resolveReferenceClaims,
} from "./linkLocatedPaths.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../../.env.local") })

const connectionString = process.env.DATABASE_URL

const ORG_ID = `org_test_link_lookups_${Date.now()}`
const REPO_ID = generateObjectId("repo")
const DECISION_KEY = `dec:${REPO_ID}:docs/adr/0001-queues.md`

const inOrg = <T>(fn: () => Promise<T>) =>
  withOrgIdContext({ id: ORG_ID, slug: "link-lookups" }, fn)

describe.skipIf(!connectionString)(
  "extract-phase graph lookups outside withOrgDbContext (Postgres)",
  () => {
    beforeAll(async () => {
      if (!connectionString) return
      initDb(connectionString)
      await getSystemDb()
        .insert(objects)
        .values(
          [
            ["Decision", DECISION_KEY],
            ["Team", "team:linear:ENG"],
            ["Service", `svc:${REPO_ID}:apps/api`],
          ].map(([kind, deduplicationKey]) => ({
            id: generateObjectId("obj"),
            orgId: ORG_ID,
            kind: kind as string,
            deduplicationKey,
            payload: {},
          })),
        )
    })

    afterAll(async () => {
      if (!connectionString) return
      try {
        await getSystemDb().delete(objects).where(eq(objects.orgId, ORG_ID))
      } finally {
        await closeDb()
      }
    })

    it("keeps references to nodes that only exist on the graph", async () => {
      const thread = "thr:slack:C01:1709372400.123456"
      const { claims, summary, stubs } = await inOrg(() =>
        resolveReferenceClaims({
          orgId: ORG_ID,
          objects: [{ kind: "Thread", deduplicationKey: thread }],
          claims: ["dec", "iss"].map((target) => ({
            subjectRef: thread,
            subjectKind: "Thread",
            objectRef: target === "dec" ? DECISION_KEY : "iss:linear:ENG-7",
            objectKind: target === "dec" ? "Decision" : "Issue",
            predicate: "REFERENCES",
            sourceId: `slackThread:${REPO_ID}:${target}:abc`,
            sourceType: "git",
            extractionMethod: "deterministic",
            confidence: 0.9,
          })),
        }),
      )

      expect(claims.map((claim) => claim.objectRef)).toEqual([
        DECISION_KEY,
        "iss:linear:ENG-7",
      ])
      expect(summary.REFERENCES).toEqual({ kept: 2, dropped: 0, stubbed: 1 })
      expect(stubs.map((stub) => stub.deduplicationKey)).toEqual([
        "iss:linear:ENG-7",
      ])
    })

    it("lists the graph's Linear team keys and package roots", async () => {
      expect(await inOrg(() => listLinearTeamKeys(ORG_ID))).toEqual(["ENG"])
      expect(
        await inOrg(() =>
          listPackageRootsForRepository({
            orgId: ORG_ID,
            repositoryId: REPO_ID,
          }),
        ),
      ).toEqual([
        {
          kind: "Service",
          repositoryId: REPO_ID,
          root: "apps/api",
          deduplicationKey: `svc:${REPO_ID}:apps/api`,
        },
      ])
    })
  },
)
