import { describe, expect, it } from "vitest"
import {
  fallbackCommitSubject,
  isBootstrapAllowedPath,
  isWorkspaceWriteJobKind,
  kindsWithinRetryCap,
  shouldEnqueueAfterHydrate,
  shouldEnqueueWorkspaceWriteJob,
  shouldPushWorkspaceWriteJob,
  shouldRetryWriteJobKind,
  WORKSPACE_WRITE_JOB_KINDS,
  WRITE_JOB_RETRY_CAP_PER_SHA,
} from "./write-jobs.js"

describe("workspace write job kinds", () => {
  it("lists one kind per locked concern", () => {
    expect(WORKSPACE_WRITE_JOB_KINDS).toEqual([
      "extract_ingest",
      "connector_mirror",
      "claims_upgrade",
      "rename_rewrite",
      "valid_from_persist",
      "semantic_merge",
      "ops_folder_map",
      "bootstrap",
      "link_unlink",
    ])
    expect(isWorkspaceWriteJobKind("bootstrap")).toBe(true)
    expect(isWorkspaceWriteJobKind("maintenance")).toBe(false)
  })

  it("allows only bootstrap AGENTS.md and the knowledge skill", () => {
    expect(isBootstrapAllowedPath("AGENTS.md")).toBe(true)
    expect(
      isBootstrapAllowedPath(".agents/skills/ctxpipe-knowledge/SKILL.md"),
    ).toBe(true)
    expect(isBootstrapAllowedPath(".claude/skills/ctxpipe-knowledge")).toBe(
      false,
    )
    expect(isBootstrapAllowedPath("knowledge/foo.md")).toBe(false)
  })
})

describe("shouldEnqueueWorkspaceWriteJob", () => {
  it("pauses when write_status is not writable", () => {
    expect(
      shouldEnqueueWorkspaceWriteJob({
        writeStatus: "read_only",
        jobGeneration: 2,
        desiredGeneration: 2,
      }),
    ).toEqual({ enqueue: false, reason: "paused" })
    expect(
      shouldEnqueueWorkspaceWriteJob({
        writeStatus: "unknown",
        jobGeneration: 1,
        desiredGeneration: 1,
      }),
    ).toEqual({ enqueue: false, reason: "paused" })
  })

  it("refuses a stale generation after relink", () => {
    expect(
      shouldEnqueueWorkspaceWriteJob({
        writeStatus: "writable",
        jobGeneration: 1,
        desiredGeneration: 2,
      }),
    ).toEqual({ enqueue: false, reason: "stale_generation" })
  })

  it("enqueues only the current writable generation", () => {
    expect(
      shouldEnqueueWorkspaceWriteJob({
        writeStatus: "writable",
        jobGeneration: 2,
        desiredGeneration: 2,
      }),
    ).toEqual({ enqueue: true })
  })
})

describe("shouldPushWorkspaceWriteJob", () => {
  it("refuses a push to the previous workspace repository", () => {
    expect(
      shouldPushWorkspaceWriteJob({
        writeStatus: "writable",
        jobGeneration: 2,
        desiredGeneration: 2,
        jobWorkspaceUrl: "https://github.com/acme/old",
        desiredWorkspaceUrl: "https://github.com/acme/new",
      }),
    ).toEqual({ push: false, reason: "stale_url" })
  })
})

describe("kindsWithinRetryCap", () => {
  it("drops a kind that already hit the per-SHA cap", () => {
    expect(
      kindsWithinRetryCap({
        kinds: ["claims_upgrade", "ops_folder_map"],
        attemptsForSha: { claims_upgrade: WRITE_JOB_RETRY_CAP_PER_SHA },
      }),
    ).toEqual(["ops_folder_map"])
  })
})

describe("shouldRetryWriteJobKind", () => {
  it("stops when hydrate reports no remaining work for that kind", () => {
    expect(
      shouldRetryWriteJobKind({
        attemptsForSha: 1,
        remainderBefore: 3,
        remainderAfter: 1,
        hydrateReportsWork: false,
      }),
    ).toBe(false)
  })

  it("stops when the commit did not shrink the remainder", () => {
    expect(
      shouldRetryWriteJobKind({
        attemptsForSha: 1,
        remainderBefore: 2,
        remainderAfter: 2,
        hydrateReportsWork: true,
      }),
    ).toBe(false)
  })

  it("caps retries per SHA per kind", () => {
    expect(
      shouldRetryWriteJobKind({
        attemptsForSha: WRITE_JOB_RETRY_CAP_PER_SHA,
        remainderBefore: 4,
        remainderAfter: 2,
        hydrateReportsWork: true,
      }),
    ).toBe(false)
    expect(
      shouldRetryWriteJobKind({
        attemptsForSha: WRITE_JOB_RETRY_CAP_PER_SHA - 1,
        remainderBefore: 4,
        remainderAfter: 2,
        hydrateReportsWork: true,
      }),
    ).toBe(true)
  })

  it("enqueues a first leftover and stops when a retry did not shrink it", () => {
    expect(
      shouldEnqueueAfterHydrate({
        attemptsForSha: 0,
        remainderBefore: 0,
        remainderAfter: 3,
      }),
    ).toBe(true)
    expect(
      shouldEnqueueAfterHydrate({
        attemptsForSha: 1,
        remainderBefore: 3,
        remainderAfter: 3,
      }),
    ).toBe(false)
    expect(
      shouldEnqueueAfterHydrate({
        attemptsForSha: 1,
        remainderBefore: 3,
        remainderAfter: 1,
      }),
    ).toBe(true)
  })
})

describe("fallbackCommitSubject", () => {
  it("uses a one-line template and strips newlines", () => {
    expect(
      fallbackCommitSubject({
        repoName: "knowledge",
        trigger: "confluence\npage",
      }),
    ).toBe("ctxpipe - Knowledge update of knowledge from confluence page")
  })
})
