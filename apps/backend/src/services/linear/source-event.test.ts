import { describe, expect, it } from "vitest"
import {
  linearEventMatches,
  linearSourceEventFromPayload,
} from "./source-event.js"

const eng = { teams: ["ENG"] }
const ops = { teams: ["OPS"] }
const launch = { projects: ["project-launch"] }

function matching(payload: Record<string, unknown>) {
  const event = linearSourceEventFromPayload(payload)
  return Object.entries({ eng, ops, launch })
    .filter(([, scope]) => linearEventMatches(event, scope))
    .map(([name]) => name)
}

describe("Linear source events", () => {
  it("routes an issue to its team and its project", () => {
    expect(
      matching({
        type: "Issue",
        data: { id: "i1", identifier: "ENG-4", projectId: "project-launch" },
      }),
    ).toEqual(["eng", "launch"])
    expect(
      matching({
        type: "Issue",
        data: { id: "i1", identifier: "OPS-4", projectId: null },
      }),
    ).toEqual(["ops"])
  })

  it("routes an issue that moved teams to every team source, so the old copy updates", () => {
    expect(
      matching({
        type: "Issue",
        data: { id: "i1", identifier: "OPS-9", projectId: null },
        updatedFrom: { teamId: "team-eng" },
      }),
    ).toEqual(["eng", "ops"])
  })

  it("routes an issue that left a project to that project too", () => {
    expect(
      matching({
        type: "Issue",
        data: { id: "i1", identifier: "OPS-9", projectId: null },
        updatedFrom: { projectId: "project-launch" },
      }),
    ).toEqual(["ops", "launch"])
  })

  it("routes project events to the project source and to every team source", () => {
    for (const payload of [
      { type: "Project", data: { id: "project-launch" } },
      {
        type: "ProjectUpdate",
        data: { id: "u1", projectId: "project-launch" },
      },
    ])
      expect(matching(payload)).toEqual(["eng", "ops", "launch"])
    expect(
      matching({ type: "Project", data: { id: "project-other" } }),
    ).toEqual(["eng", "ops"])
  })

  it("routes a comment without team or project data to every source", () => {
    expect(
      matching({ type: "Comment", data: { id: "c1", issueId: "i1" } }),
    ).toEqual(["eng", "ops", "launch"])
  })

  it("keeps the entity for the incremental mirror", () => {
    const entity = {
      entityType: "issue" as const,
      externalId: "i1",
      action: "upsert" as const,
    }
    expect(
      linearSourceEventFromPayload(
        { type: "Issue", data: { identifier: "ENG-1", projectId: null } },
        entity,
      ),
    ).toEqual({ teamKeys: ["ENG"], projectIds: [], entity })
  })
})
