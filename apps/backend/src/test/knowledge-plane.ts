import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type {
  DocumentRows,
  FileDocument,
  FileRelation,
  KnowledgeScope,
  KnowledgeStore,
} from "../knowledge-store/knowledge-store.js"
import {
  beginKnowledgeRun,
  completeKnowledgeRun,
} from "../models/knowledge-state.js"

/**
 * The rows of a document as a read test gives them: the `valid_from` of its
 * tree row on the document, and `validFromIntroduced` optional (false).
 */
export type PlaneDocument = Omit<DocumentRows, "document" | "relations"> & {
  document: FileDocument & { validFrom?: Date | null }
  relations: (Omit<FileRelation, "validFromIntroduced"> & {
    validFromIntroduced?: boolean
  })[]
}

/**
 * Writes the file version of each of `documents` and its tree row of
 * `branch` at `treeVersion`, as a run of the writer does (ADR-071). The
 * version of a file version is a hash of its rows, so other rows of a path
 * get another version. A test that reads the plane then completes the run
 * with this branch and tree version (`completeKnowledgeRun`).
 */
export async function writePlaneDocuments(
  store: KnowledgeStore,
  scope: KnowledgeScope,
  documents: PlaneDocument[],
  { branch = "main", treeVersion = 1 } = {},
): Promise<void> {
  const versions = documents.map(({ document, relations, ...rows }) => {
    const content = {
      ...rows,
      document,
      relations: relations.map((relation) => ({
        ...relation,
        validFromIntroduced: relation.validFromIntroduced ?? false,
      })),
    }
    return {
      ...content,
      version: createHash("sha256")
        .update(JSON.stringify(content))
        .digest("hex")
        .slice(0, 32),
    }
  })
  await store.writeFileVersions(scope, versions)
  await store.writeTree(
    scope,
    branch,
    treeVersion,
    versions.map(({ document, version }, index) => ({
      docKey: document.docKey,
      version,
      path: document.path,
      status: "active",
      kind: document.kind,
      observedAt: document.observedAt,
      validFrom: documents[index]?.document.validFrom ?? null,
      validTo: document.validTo,
      deletedAt: null,
    })),
  )
}

/**
 * Complete a knowledge run of `tip` on the default branch `main` of a
 * Workspace, as tree `treeVersion`: the plane then serves the Workspace at
 * `tip`.
 */
export async function servePlaneHead(input: {
  orgId: string
  workspaceId: string
  tip: string
  treeVersion?: number
}): Promise<void> {
  const { orgId, workspaceId } = input
  await beginKnowledgeRun({
    orgId,
    workspaceId,
    branch: "main",
    isDefault: true,
  })
  await completeKnowledgeRun({
    orgId,
    workspaceId,
    tip: input.tip,
    branch: "main",
    treeVersion: input.treeVersion ?? 1,
    baseBranch: null,
    projectionVersion: "test",
    failedCount: 0,
  })
}

/**
 * A Git repository in a new temporary folder with `files` in one commit.
 * Returns its path (the remote URL of a Workspace) and the SHA. The caller
 * removes the folder.
 */
export function gitRepository(files: Record<string, string>): {
  url: string
  sha: string
} {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-plane-git-"))
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    }).trim()
  git("init", "-q", "-b", "main")
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), content)
  }
  git("add", "-A")
  git("commit", "-q", "-m", "fixture")
  return { url: directory, sha: git("rev-parse", "HEAD") }
}
