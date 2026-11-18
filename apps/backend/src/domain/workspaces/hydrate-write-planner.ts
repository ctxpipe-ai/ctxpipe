import type { GitReadSession } from "../../services/git/clone-tree.js"
import { nativeGit } from "../../services/git/pack.js"
import { repositorySourcePathsAtRevision } from "../workspace-sources/github-sources.js"
import type {
  PreviousSourceRow,
  SourceFileBlob,
} from "../workspace-sources/projection-plan.js"
import { BOOTSTRAP_SKILL_PATH, bootstrapWorkspaceFiles } from "./bootstrap.js"
import { folderSetChanged, removeFolderMapMarkers } from "./folder-list.js"
import {
  hydrateKnowledgeTree,
  type KnowledgePlanFacts,
  knowledgePlanFacts,
} from "./hydrate.js"
import { renameRewriteFilesIn } from "./native-rename-rewrite.js"
import type { WorkspaceRevision } from "./revision.js"
import {
  INGESTION_V2_PUBLISH_FORMAT,
  readWorkspaceFormat,
  WORKSPACE_FORMAT_PATH,
  workspaceFormatAtLeast,
  workspaceFormatCacheValue,
} from "./workspace-format.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

export type HydrateWriteRequirement =
  | {
      kind:
        | "bootstrap"
        | "import_key_cleanup"
        | "ownership_migration"
        | "claims_upgrade"
        | "valid_from_persist"
      remainder: number
    }
  | {
      kind: "ops_folder_map"
      remainder: number
      /** Set when the folder set changed since this hydrated revision. */
      previousSha?: string
    }
  | { kind: "rename_rewrite"; remainder: number; previousSha: string }

/** The changes between the last hydrated revision and this one. */
export type HydrateWriteHistory = {
  previousSha: string
  /** The format in the tree of `previousSha`. */
  previousFormat: number
  /** Files whose links a rename made stale. */
  renameRewrites: number
  /** True when the set of listed folders changed. */
  folderSetChanged: boolean
}

/** The files outside the knowledge units that the plan reads. */
export const PLANNED_CONTROL_FILES: readonly string[] = [
  "AGENTS.md",
  BOOTSTRAP_SKILL_PATH,
]

/**
 * What the plan reads from the tree: the plan facts of each knowledge file
 * (`knowledgePlanFacts`) and the text of each control file. Hydrate gives
 * the values of its own parse, so the plan parses no file again.
 */
export type HydratePlanParse = {
  facts: readonly KnowledgePlanFacts[]
  /** The text of each file of `PLANNED_CONTROL_FILES` that the tree has. */
  existing: ReadonlyMap<string, string>
}

/** The plan parse of a list of files, for a caller without a hydrate parse. */
export function hydratePlanParseOfFiles(
  revision: WorkspaceRevision,
  files: ReadonlyArray<{ path: string; content: string }>,
): HydratePlanParse {
  return {
    facts: knowledgePlanFacts(
      hydrateKnowledgeTree({
        workspaceId: revision.workspaceId,
        workspaceUrl: revision.remote.url,
        files,
      }),
    ),
    existing: plannedControlFiles(files),
  }
}

/** The text of each file of `PLANNED_CONTROL_FILES` in `files`. */
export function plannedControlFiles(
  files: ReadonlyArray<{ path: string; content: string }>,
): Map<string, string> {
  return new Map(
    files
      .filter((file) => PLANNED_CONTROL_FILES.includes(file.path))
      .map((file) => [file.path, file.content]),
  )
}

/**
 * The history of the write plan (`HydrateWriteHistory`), from the Git
 * directory of the hydrate read: the plan fetches no Git pack of its own.
 */
export async function readHydrateWriteHistory(
  session: GitReadSession,
  input: { sha: string; previousSha: string; root?: string },
): Promise<HydrateWriteHistory> {
  const { directory, fetchObjects } = session
  await fetchObjects([input.previousSha])
  const rootTree = async (sha: string) =>
    (
      await nativeGit(directory, [
        "--no-lazy-fetch",
        "rev-parse",
        "--verify",
        "--quiet",
        input.root ? `${sha}:${input.root}` : `${sha}^{tree}`,
      ]).catch(() => Buffer.from(""))
    )
      .toString()
      .trim() || null
  const blobsAt = async (tree: string | null) =>
    tree
      ? (
          await nativeGit(directory, [
            "--no-lazy-fetch",
            "ls-tree",
            "-r",
            "-z",
            tree,
          ])
        )
          .toString()
          .split("\0")
          .flatMap((entry) => {
            const match = /^\d+ \w+ ([0-9a-f]+)\t(.+)$/s.exec(entry)
            return match?.[1] && match[2]
              ? [{ sha: match[1], path: match[2] }]
              : []
          })
      : []
  const previousTree = await rootTree(input.previousSha)
  const currentTree = await rootTree(input.sha)
  const previousBlobs = await blobsAt(previousTree)
  const formatBlob = previousBlobs.find(
    (blob) => blob.path === WORKSPACE_FORMAT_PATH,
  )
  let previousFormatFile: string | null = null
  if (formatBlob) {
    await fetchObjects([formatBlob.sha])
    previousFormatFile = (
      await nativeGit(directory, ["cat-file", "blob", formatBlob.sha])
    ).toString()
  }
  return {
    previousSha: input.previousSha,
    previousFormat: workspaceFormatCacheValue(
      readWorkspaceFormat(previousFormatFile),
    ),
    renameRewrites:
      previousTree && currentTree
        ? (
            await renameRewriteFilesIn(
              directory,
              previousTree,
              currentTree,
              fetchObjects,
            )
          ).length
        : 0,
    folderSetChanged: folderSetChanged(
      previousBlobs.map((blob) => blob.path),
      (await blobsAt(currentTree)).map((blob) => blob.path),
    ),
  }
}

/**
 * Plan the direct writes of hydrate from committed files, before hydrate
 * supplies derived valid_from values. Each planned job commits to the
 * default branch with no pull request.
 *
 * Below format 3 hydrate plans no write (ADR-053 section 7): the upgrade
 * pull request makes each layout change, also the bootstrap files and the
 * claim and valid_from rewrites. At format 3 or more these are ctxpipe-managed
 * files of a v2 Workspace, so hydrate keeps them current.
 */
export async function planHydrateWrites(input: {
  revision: WorkspaceRevision
  displayName: string
  parsed: HydratePlanParse
  /** The blobs under `sources/`: the source path of each repository. */
  sourceFiles: ReadonlyArray<SourceFileBlob>
  /** The stored source rows: they decide the winner of a repository. */
  sourceRows: ReadonlyArray<PreviousSourceRow>
  /** The format in the tree of `revision` (0 for no file, -1 for an invalid one). */
  format: number
  /** Read only when hydrate can write; null when no earlier revision differs. */
  history?: () => Promise<HydrateWriteHistory | null>
}): Promise<HydrateWriteRequirement[]> {
  if (!githubRepoFullNameFromWorkspaceUrl(input.revision.remote.url)) return []
  const writable = (format: number) =>
    workspaceFormatAtLeast(format, INGESTION_V2_PUBLISH_FORMAT)
  if (!writable(input.format)) return []
  const { facts, existing } = input.parsed
  const agentsMd = existing.get("AGENTS.md") ?? ""
  const sourcePaths = repositorySourcePathsAtRevision(
    input.sourceFiles,
    input.sourceRows,
  )
  const remaining = {
    bootstrap: bootstrapWorkspaceFiles({
      displayName: input.displayName,
      existing,
    }).filter((file) => existing.get(file.path) !== file.content).length,
    claims_upgrade: facts.filter((fact) => fact.claimsUpgrade).length,
    valid_from_persist: facts.filter((fact) => fact.validFromPersist).length,
    import_key_cleanup: facts.filter((fact) => fact.importKey).length,
    // Retired folder-map marker lines still in AGENTS.md: one cleanup write.
    ops_folder_map: removeFolderMapMarkers(agentsMd) === agentsMd ? 0 : 1,
    // The files that `ownershipMigrationFiles` changes.
    ownership_migration: facts.filter(
      (fact) =>
        fact.legacySourceUrl !== null && sourcePaths.has(fact.legacySourceUrl),
    ).length,
  }
  const plan: HydrateWriteRequirement[] = (
    Object.keys(remaining) as Array<keyof typeof remaining>
  )
    .filter((kind) => remaining[kind] > 0)
    .map((kind) => ({ kind, remainder: remaining[kind] }))
  const history = await input.history?.()
  // From a tree below format 3, the change is the upgrade pull request. Its
  // moves are layout changes, not renames of a person, and its last step
  // wrote AGENTS.md. Hydrate has no write to add.
  if (!history || !writable(history.previousFormat)) return plan
  if (history.renameRewrites > 0)
    plan.push({
      kind: "rename_rewrite",
      previousSha: history.previousSha,
      remainder: history.renameRewrites,
    })
  if (history.folderSetChanged) {
    // One job both removes old markers and updates the list.
    const planned = plan.find(
      (requirement) => requirement.kind === "ops_folder_map",
    )
    if (planned?.kind === "ops_folder_map") {
      planned.previousSha = history.previousSha
      planned.remainder += 1
    } else
      plan.push({
        kind: "ops_folder_map",
        previousSha: history.previousSha,
        remainder: 1,
      })
  }
  return plan
}
