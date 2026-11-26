import { describe, expect, it } from "vitest"

import { renderGithubPullRequest } from "../../services/github/pull-request-mirror/converter.js"
import { toNotionMarkdownFile } from "../../services/notion/converter.js"
import { pagerdutyIncidentMirrorFiles } from "../../services/pagerduty/converter.js"
import { plainThreadFile } from "../../services/plain/converter.js"
import { toSlackThreadMarkdownFile } from "../../services/slack/converter.js"
import { shopIssue } from "../../test/github-issue.js"
import { linearIssueFile } from "../../test/linear-issue.js"
import { diffHydrateUnits, hydrateUnitHash } from "./hydrate-delta.js"
import { validFromPersistFiles } from "./hydrate-write-jobs.js"
import {
  applyEffectiveValidFromToUnits,
  hydrateKnowledgeTree,
  hydrateUnitsToProjectionClaims,
} from "./hydrate.js"

/** The source time of one file, through the hydrate parse. */
function sourceTimeOf(path: string, content: string): string | null {
  const { units } = hydrateKnowledgeTree({
    workspaceId: "ws_source_time",
    files: [{ path, content }],
  })
  return units[0]?.sourceTime ?? null
}

describe("the source time of a file (CTX-1516)", () => {
  it("is the createdAt of a GitHub issue mirror file", () => {
    expect(
      sourceTimeOf(
        "github/issues/acme/api/12.md",
        "---\nsource: github\ntype: issue\ncreatedAt: 2019-03-04T05:06:07Z\nclosedAt: 2020-01-02T00:00:00Z\n---\n# Flaky test\n",
      ),
    ).toBe("2019-03-04T05:06:07.000Z")
  })

  it("is the createdAt of a GitHub pull request mirror file", () => {
    expect(
      sourceTimeOf(
        "github/pulls/acme/api/40.md",
        "---\nsource: github\ntype: pull_request\ncreatedAt: '2021-06-01T10:00:00Z'\nmergedAt: '2021-06-03T10:00:00Z'\nmerged: true\n---\n# Add cache\n",
      ),
    ).toBe("2021-06-01T10:00:00.000Z")
  })

  it("is the createdAt of a Linear issue mirror file", () => {
    expect(
      sourceTimeOf(
        "linear/teams/ENG/issues/eng-7--a1.md",
        "---\nsource: linear\ntype: issue\nidentifier: ENG-7\ncreatedAt: 2022-02-02T02:02:02.000Z\nupdatedAt: 2023-01-01T00:00:00.000Z\n---\n# ENG-7: Retry\n",
      ),
    ).toBe("2022-02-02T02:02:02.000Z")
  })

  it("is the created_at of a Plain, PagerDuty or Buildkite mirror file", () => {
    for (const path of [
      "plain/threads/th_1.md",
      "pagerduty/incidents/P1.md",
      "buildkite/builds/b1.md",
    ])
      expect(
        sourceTimeOf(
          path,
          '---\ncreated_at: "2021-04-05T06:07:08Z"\n---\n# A\n',
        ),
        path,
      ).toBe("2021-04-05T06:07:08.000Z")
  })

  it("is the thread_ts of a Slack thread", () => {
    expect(
      sourceTimeOf(
        "slack/eng--C01/threads/1700000000.000100/thread.md",
        '---\nthread_ts: "1700000000.000100"\n---\n# Thread\n',
      ),
    ).toBe("2023-11-14T22:13:20.000Z")
  })

  it("is the Date line of a decision unit (KEP, RFC, ADR)", () => {
    expect(
      sourceTimeOf(
        "knowledge/decisions/kep-1287.md",
        '---\nkind: Decision\nname: "In-place resize"\n---\n# In-place resize\n\n**Status:** Implementable\n**Date:** 2019-01-18\n**Source:** `keps/sig-node/1287/README.md`\n',
      ),
    ).toBe("2019-01-18T00:00:00.000Z")
  })

  it("is the Date of an ADR, also after the Status on the same line", () => {
    expect(
      sourceTimeOf(
        "decisions/ADR-012-queue.md",
        "# ADR-012: Queue\n\n**Status:** Accepted | **Date:** 2024-05-06 (revised 2024-07-01)\n",
      ),
    ).toBe("2024-05-06T00:00:00.000Z")
  })

  it("is the front matter date of a decision", () => {
    expect(
      sourceTimeOf(
        "knowledge/decisions/rfc-2094.md",
        "---\nkind: Decision\ndate: 2017-08-02\n---\n# Non-lexical lifetimes\n",
      ),
    ).toBe("2017-08-02T00:00:00.000Z")
  })

  it("is null for a file with no time of its own", () => {
    // A plain knowledge unit, a Notion page (only its last edit) and a
    // `createdAt` outside a mirror take the time of the introducing commit.
    expect(
      sourceTimeOf("knowledge/services/billing.md", "# Billing\n\nDate: x\n"),
    ).toBeNull()
    expect(
      sourceTimeOf(
        "notion/pages/roadmap--1.md",
        '---\nlast_edited_time: "2024-01-01T00:00:00.000Z"\n---\n# Roadmap\n',
      ),
    ).toBeNull()
    expect(
      sourceTimeOf(
        "knowledge/services/api.md",
        "---\nkind: Service\ncreatedAt: 2020-01-01T00:00:00Z\n---\n# API\n\n**Date:** 2020-01-01\n",
      ),
    ).toBeNull()
  })

  it("is null for a value that is not a time", () => {
    expect(
      sourceTimeOf(
        "github/issues/acme/api/13.md",
        "---\nsource: github\ncreatedAt: soon\n---\n# Issue\n",
      ),
    ).toBeNull()
  })
})

describe("the old stack takes the source time before the commit time", () => {
  const decision = {
    path: "knowledge/decisions/kep-1287.md",
    content:
      '---\nkind: Decision\nname: "In-place resize"\nclaims:\n  - to: ./kubelet.md\n    predicate: INFLUENCES\n    evidence:\n      kind: script\n---\n# In-place resize\n\n**Date:** 2019-01-18\n',
  }
  const kubelet = {
    path: "knowledge/decisions/kubelet.md",
    content: "---\nkind: Service\n---\n# Kubelet\n",
  }
  const commit = "2026-11-21T09:00:00.000Z"
  const { units } = hydrateKnowledgeTree({
    workspaceId: "ws_source_time",
    files: [decision, kubelet],
  })

  it("in the Postgres claims of a hydrate", () => {
    const [unit] = applyEffectiveValidFromToUnits(
      units,
      new Map([[decision.path, commit]]),
    )
    expect(unit?.claims[0]?.validFrom).toBe("2019-01-18T00:00:00.000Z")
  })

  it("in the graph projection", () => {
    const claim = hydrateUnitsToProjectionClaims(units, commit).find(
      ({ predicate }) => predicate === "INFLUENCES",
    )
    expect(claim?.validFrom).toBe("2019-01-18T00:00:00.000Z")
  })

  it("in the valid_from that the persist job writes to Git", () => {
    const [file] = validFromPersistFiles({
      files: [decision],
      units,
      introducingCommitTimestamp: commit,
    })
    expect(file?.content).toContain("valid_from: 2019-01-18T00:00:00.000Z")
    expect(file?.content).not.toContain(commit)
  })

  it("and keeps the commit time for a file with no source time", () => {
    const plain = hydrateKnowledgeTree({
      workspaceId: "ws_source_time",
      files: [
        {
          path: "knowledge/services/api.md",
          content:
            "---\nkind: Service\nclaims:\n  - to: ./db.md\n    predicate: DEPENDS_ON\n---\n# API\n",
        },
      ],
    }).units
    expect(
      applyEffectiveValidFromToUnits(
        plain,
        new Map([["knowledge/services/api.md", commit]]),
      )[0]?.claims[0]?.validFrom,
    ).toBe(commit)
  })
})

describe("the old stack links an issue to the pull request that closed it from the close", () => {
  it("in the graph projection, as on the plane", () => {
    const issue = shopIssue({
      number: 7,
      title: "Checkout times out",
      body: "The checkout times out.",
      closed: {
        at: "2020-06-01T00:00:00Z",
        by: ["https://github.com/acme/shop/pull/9"],
      },
    })
    const pull = {
      path: "github/pulls/acme/shop/9--9.md",
      content:
        "---\nsource: github\ntype: pull_request\nnumber: 9\nrepository: acme/shop\nurl: https://github.com/acme/shop/pull/9\ncreatedAt: 2020-05-20T00:00:00Z\n---\n# Fix the timeout\n",
    }
    const { units } = hydrateKnowledgeTree({
      workspaceId: "ws_source_time",
      files: [issue, pull],
    })
    const links = hydrateUnitsToProjectionClaims(units, "2026-11-21T09:00:00Z")
      .filter(({ predicate }) => predicate === "LINKS_TO")
      .map(({ subjectId, objectId, validFrom }) => ({
        from: units.find((unit) => unit.servingId === subjectId)?.path,
        to: units.find((unit) => unit.servingId === objectId)?.path,
        validFrom,
      }))
    expect(links).toContainEqual({
      from: issue.path,
      to: pull.path,
      validFrom: "2020-06-01T00:00:00.000Z",
    })
  })

  it("links a done Linear issue to each mirrored merged pull request of its attachments from the time it was completed (CTX-1526)", () => {
    const issue = linearIssueFile({
      identifier: "ENG-4",
      completedAt: "2026-03-10T12:00:00Z",
      pulls: [{ url: "https://github.com/acme/shop/pull/9", state: "merged" }],
    })
    const pull = {
      path: "github/pulls/acme/shop/9--9.md",
      content:
        "---\nsource: github\ntype: pull_request\nnumber: 9\nrepository: acme/shop\nurl: https://github.com/acme/shop/pull/9\ncreatedAt: 2026-03-01T00:00:00Z\n---\n# Fix the timeout\n",
    }
    const { units } = hydrateKnowledgeTree({
      workspaceId: "ws_source_time",
      files: [issue, pull],
    })
    const links = hydrateUnitsToProjectionClaims(units, "2026-11-21T09:00:00Z")
      .filter(({ predicate }) => predicate === "LINKS_TO")
      .map(({ subjectId, objectId, validFrom }) => ({
        from: units.find((unit) => unit.servingId === subjectId)?.path,
        to: units.find((unit) => unit.servingId === objectId)?.path,
        validFrom,
      }))
    expect(links).toContainEqual({
      from: issue.path,
      to: pull.path,
      validFrom: "2026-03-10T12:00:00.000Z",
    })
  })
})

describe("the old stack's updatedAt is the source's own time of the last change (CTX-1692)", () => {
  // A mirror format change rewrote each mirror file in this commit.
  const rewrite = "2026-11-24T03:00:00.000Z"

  /** The updatedAt of one file, through the hydrate parse. */
  function updatedAtOf(file: { path: string; content: string }) {
    const { units } = hydrateKnowledgeTree({
      workspaceId: "ws_source_updated_time",
      files: [{ ...file, lastCommitTimestamp: rewrite }],
    })
    return units[0]?.updatedAt ?? null
  }

  it("is the updatedAt of a Linear issue mirror file", () => {
    expect(updatedAtOf(linearIssueFile({ identifier: "ENG-7" }))).toBe(
      "2026-01-02T00:00:00.000Z",
    )
  })

  it("is the updatedAt of a GitHub issue mirror file", () => {
    expect(
      updatedAtOf(shopIssue({ title: "Flaky test", body: "Fails." })),
    ).toBe("2026-09-01T00:00:00.000Z")
  })

  it("is the updatedAt of a GitHub pull request mirror file", () => {
    const file = renderGithubPullRequest({
      id: 40,
      number: 40,
      repository: "acme/api",
      url: "https://github.com/acme/api/pull/40",
      title: "Add cache",
      body: "",
      state: "closed",
      merged: true,
      mergedAt: "2021-06-03T10:00:00Z",
      draft: false,
      author: { login: "dev", type: "human" },
      base: { ref: "main", sha: "a".repeat(40) },
      head: { ref: "cache", sha: "b".repeat(40) },
      reviewDecision: null,
      labels: [],
      requestedReviewers: [],
      createdAt: "2021-06-01T10:00:00Z",
      updatedAt: "2021-06-05T10:00:00Z",
      files: [],
      reviews: [],
      comments: [],
      requiredChecks: [],
    })
    expect(updatedAtOf(file)).toBe("2021-06-05T10:00:00.000Z")
  })

  it("is the updated_at of a Plain thread", () => {
    const file = plainThreadFile({
      labelTypeId: "lt_1",
      thread: {
        id: "th_1",
        ref: "T-1",
        title: "Login fails",
        status: "DONE",
        priority: 2,
        customerName: null,
        labels: [],
        createdAt: "2021-04-05T06:07:08Z",
        updatedAt: "2021-04-06T00:00:00Z",
        messages: [],
        moreMessages: false,
      },
    })
    expect(updatedAtOf(file)).toBe("2021-04-06T00:00:00.000Z")
  })

  it("is the updated_at of a PagerDuty incident", () => {
    const [file] = pagerdutyIncidentMirrorFiles({
      id: "P1",
      number: 1,
      title: "API down",
      htmlUrl: "https://acme.pagerduty.com/incidents/P1",
      status: "resolved",
      createdAt: "2021-04-05T06:07:08Z",
      updatedAt: "2021-04-07T00:00:00Z",
      serviceId: "S1",
      alerts: [],
      notes: [],
    })
    if (!file) throw new Error("Expected a file")
    expect(updatedAtOf(file)).toBe("2021-04-07T00:00:00.000Z")
  })

  it("is the last_edited_time of a Notion page", () => {
    const file = toNotionMarkdownFile({
      resource: { externalId: "page-1", title: "Roadmap" },
      page: { id: "page-1", last_edited_time: "2024-05-06T07:08:00.000Z" },
      blocks: [],
    })
    expect(updatedAtOf(file)).toBe("2024-05-06T07:08:00.000Z")
  })

  it("is the time of the last reply of a Slack thread", () => {
    const file = toSlackThreadMarkdownFile({
      channelId: "C01",
      channelName: "eng",
      isPrivate: false,
      threadTs: "1700000000.000100",
      messages: [
        { ts: "1700000000.000100", text: "The deploy is stuck." },
        { ts: "1700003600.000200", text: "Fixed." },
      ],
    })
    expect(updatedAtOf(file)).toBe("2023-11-14T23:13:20.000Z")
  })

  it("makes the next hydrate write again each row that has the commit time", () => {
    // A row from before CTX-1692 has the commit time in its hash, so the
    // next hydrate of a Workspace writes the source time to it.
    const [unit] = hydrateKnowledgeTree({
      workspaceId: "ws_source_updated_time",
      files: [
        {
          ...linearIssueFile({ identifier: "ENG-7" }),
          lastCommitTimestamp: rewrite,
        },
      ],
    }).units
    if (!unit) throw new Error("Expected a unit")
    const stored = {
      servingId: unit.servingId,
      unitHash: hydrateUnitHash({ ...unit, updatedAt: rewrite }, "model"),
    }
    expect(diffHydrateUnits([stored], [unit], "model").changed).toEqual([unit])
  })

  it("is the commit time for a file with no time of its own", () => {
    // An authored file, a Slack channel index, a Confluence page, and
    // mirror files with a value that is not a time.
    for (const file of [
      {
        path: "knowledge/services/api.md",
        content:
          "---\nkind: Service\nupdatedAt: 2020-01-01T00:00:00Z\n---\n# API\n",
      },
      {
        path: "slack/eng--C01/index.md",
        content: '---\nsource: slack\nchannel_id: "C01"\n---\n# #eng\n',
      },
      { path: "confluence/ENG/runbook--1.md", content: "# Runbook\n" },
      {
        path: "github/issues/acme/api/13.md",
        content: "---\nsource: github\nupdatedAt: soon\n---\n# Issue\n",
      },
      {
        path: "slack/eng--C01/threads/1700000000.000100/thread.md",
        content:
          '---\nsource: slack\nthread_ts: "1700000000.000100"\nlatest: "1e20"\n---\n# Thread\n',
      },
    ])
      expect(updatedAtOf(file), file.path).toBe(rewrite)
  })
})
