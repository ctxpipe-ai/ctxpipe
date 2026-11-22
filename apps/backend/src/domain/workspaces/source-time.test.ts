import { describe, expect, it } from "vitest"

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
