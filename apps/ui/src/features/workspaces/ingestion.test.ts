import { describe, expect, it } from "vitest"

import { ingestionItemFixture } from "@/mocks/workspace-ingestion-handlers"

import { groupSourceRuns, sourceRunsWord } from "./ingestion"

describe("groupSourceRuns", () => {
  it("groups the runs of one repository, the oldest first, and the furthest run leads", () => {
    const groups = groupSourceRuns([
      ingestionItemFixture({ id: "run_new", stage: "waiting", minutesAgo: 2 }),
      ingestionItemFixture({
        id: "run_old",
        stage: "ingesting",
        minutesAgo: 30,
      }),
      ingestionItemFixture({
        id: "run_mid",
        stage: "publishing",
        minutesAgo: 10,
      }),
    ])
    expect(groups).toHaveLength(1)
    const [web] = groups
    expect(web?.title).toBe("acme/web")
    expect(web?.runs.map((run) => run.id)).toEqual([
      "run_old",
      "run_mid",
      "run_new",
    ])
    expect(web?.lead.id).toBe("run_mid")
    expect(web && sourceRunsWord(web)).toBe("Publishing")
  })

  it("keeps each source apart, names a sync by its provider, and leaves out a hydrate", () => {
    const groups = groupSourceRuns([
      ingestionItemFixture({ id: "run_web" }),
      ingestionItemFixture({ id: "run_api", name: "acme/api" }),
      ingestionItemFixture({
        id: "run_linear",
        kind: "source_sync",
        name: "Linear",
        stage: null,
        progress: null,
      }),
      ingestionItemFixture({ id: "run_hydrate", kind: "hydrate", name: null }),
    ])
    expect(groups.map((group) => group.title)).toEqual([
      "acme/web",
      "acme/api",
      "Linear sources",
    ])
    const linear = groups.find((group) => group.kind === "source_sync")
    expect(linear && sourceRunsWord(linear)).toBe("Syncing")
  })

  it("returns nothing when only a hydrate runs", () => {
    expect(
      groupSourceRuns([ingestionItemFixture({ kind: "hydrate", name: null })]),
    ).toEqual([])
  })
})
