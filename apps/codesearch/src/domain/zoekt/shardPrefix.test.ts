import { describe, expect, it } from "vitest"
import {
  isZoektShardBasenameForRepo,
  zoektShardFilePrefix,
} from "./shardPrefix.js"

describe("zoektShardFilePrefix", () => {
  it("matches zoekt url.QueryEscape style for owner/repo names", () => {
    expect(zoektShardFilePrefix("kubernetes/kubernetes")).toBe(
      "kubernetes%2Fkubernetes_",
    )
    expect(zoektShardFilePrefix("SOURCEDIGITAL/docker-swarm")).toBe(
      "SOURCEDIGITAL%2Fdocker-swarm_",
    )
  })

  it("does not use the old slash-to-underscore convention", () => {
    expect(zoektShardFilePrefix("owner/repo")).not.toBe("owner_repo_")
  })
})

describe("isZoektShardBasenameForRepo", () => {
  it("matches multi-shard and .meta sidecars", () => {
    const repo = "kubernetes/kubernetes"
    expect(
      isZoektShardBasenameForRepo(
        "kubernetes%2Fkubernetes_v16.00000.zoekt",
        repo,
      ),
    ).toBe(true)
    expect(
      isZoektShardBasenameForRepo(
        "kubernetes%2Fkubernetes_v16.00002.zoekt",
        repo,
      ),
    ).toBe(true)
    expect(
      isZoektShardBasenameForRepo(
        "kubernetes%2Fkubernetes_v16.00000.zoekt.meta",
        repo,
      ),
    ).toBe(true)
  })

  it("rejects other repos and non-shard files", () => {
    const repo = "owner/repo"
    expect(
      isZoektShardBasenameForRepo("other%2Frepo_v16.00000.zoekt", repo),
    ).toBe(false)
    expect(isZoektShardBasenameForRepo("owner%2Frepo_v16.00000.txt", repo)).toBe(
      false,
    )
  })
})
