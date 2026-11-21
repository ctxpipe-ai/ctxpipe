import { createHash } from "node:crypto"

import type {
  DocumentRows,
  FileDocument,
  FileRelation,
  KnowledgeScope,
  KnowledgeStore,
} from "../knowledge-store/knowledge-store.js"

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
    const { validFrom: _validFrom, ...fields } = document
    const content = {
      ...rows,
      document: fields,
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
      blobSha: "",
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
