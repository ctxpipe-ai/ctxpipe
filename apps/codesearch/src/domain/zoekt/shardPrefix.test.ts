import { describe, expect, it } from "vitest"
import {
  isZoektShardBasenameForName,
  zoektRepositoryName,
  zoektShardFilePrefix,
} from "./shardPrefix.js"

describe("zoektRepositoryName", () => {
  it("keys names by immutable org and repository identity", () => {
    expect(
      zoektRepositoryName({ orgId: "org_alpha", repoId: "repo_same" }),
    ).toBe("ctxpipe:v1:org:org_alpha:repo:repo_same")
    expect(
      zoektRepositoryName({ orgId: "org_alpha", repoId: "repo_same" }),
    ).not.toBe(zoektRepositoryName({ orgId: "org_beta", repoId: "repo_same" }))
    expect(
      zoektRepositoryName({
        orgId: "org_alpha",
        repoId: "repo_same",
        checkoutKey: "ws:ws_1",
      }),
    ).toBe("ctxpipe:v1:org:org_alpha:repo:repo_same:checkout:ws:ws_1")
  })
})

describe("zoektShardFilePrefix", () => {
  it("matches zoekt url.QueryEscape style for stable names", () => {
    expect(
      zoektShardFilePrefix(
        zoektRepositoryName({ orgId: "org_alpha", repoId: "repo_main" }),
      ),
    ).toBe("ctxpipe%3Av1%3Aorg%3Aorg_alpha%3Arepo%3Arepo_main_")
  })
})

describe("isZoektShardBasenameForName", () => {
  it("matches multi-shard and .meta sidecars", () => {
    const zoektName = zoektRepositoryName({
      orgId: "org_alpha",
      repoId: "repo_main",
    })
    const prefix = zoektShardFilePrefix(zoektName)
    expect(
      isZoektShardBasenameForName(`${prefix}v16.00000.zoekt`, zoektName),
    ).toBe(true)
    expect(
      isZoektShardBasenameForName(`${prefix}v16.00002.zoekt`, zoektName),
    ).toBe(true)
    expect(
      isZoektShardBasenameForName(`${prefix}v16.00000.zoekt.meta`, zoektName),
    ).toBe(true)
  })

  it("rejects adjacent names instead of prefix-matching", () => {
    const foo = zoektRepositoryName({ orgId: "org_alpha", repoId: "repo_foo" })
    const fooBar = zoektRepositoryName({
      orgId: "org_alpha",
      repoId: "repo_foo_bar",
    })

    expect(
      isZoektShardBasenameForName(
        `${zoektShardFilePrefix(fooBar)}v16.00000.zoekt`,
        foo,
      ),
    ).toBe(false)
  })

  it("rejects other repos, malformed files, and legacy display-name shards", () => {
    const zoektName = zoektRepositoryName({
      orgId: "org_alpha",
      repoId: "repo_main",
    })
    const otherName = zoektRepositoryName({
      orgId: "org_alpha",
      repoId: "repo_other",
    })
    expect(
      isZoektShardBasenameForName(
        `${zoektShardFilePrefix(otherName)}v16.00000.zoekt`,
        zoektName,
      ),
    ).toBe(false)
    expect(
      isZoektShardBasenameForName(
        `${zoektShardFilePrefix(zoektName)}v16.00000.txt`,
        zoektName,
      ),
    ).toBe(false)
    expect(
      isZoektShardBasenameForName("owner%2Frepo_v16.00000.zoekt", zoektName),
    ).toBe(false)
  })
})
