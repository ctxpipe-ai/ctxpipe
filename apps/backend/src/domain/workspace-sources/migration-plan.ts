import type { Env } from "../../config/env.js"
import { confluenceSourceMigrationHook } from "../../services/confluence/workspace-source-migration.js"
import { linearSourceMigrationHook } from "../../services/linear/source-migration.js"
import { notionSourceMigrationHook } from "../../services/notion/workspace-source-migration.js"
import { pagerdutySourceMigrationHook } from "../../services/pagerduty/workspace-source-migration.js"
import { slackSourceMigrationHook } from "../../services/slack/source-migration.js"
import { parseLinkedRepositoryMarkdown } from "../workspaces/layout.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../workspaces/write-status.js"
import type { SourceChange } from "./edit.js"
import {
  parseSourceEntry,
  type SourceProvider,
  sourcesFileSchema,
} from "./sources-file.js"
import { parseSourcesYaml } from "./sources-yaml.js"

/** What one existing connection syncs today, read from its config (ADR-050 migration). */
export type LegacySourceBinding =
  | {
      provider: SourceProvider
      connectionId: string
      /** The connection's old sync repository. */
      syncRepositoryUrl: string
      scope: Record<string, unknown>
      /**
       * Map only to the Workspace whose own repository is the sync
       * repository, not to a Workspace that links it.
       */
      ownRepositoryOnly?: boolean
    }
  | {
      provider: SourceProvider
      connectionId: string
      /** Why this connection's config does not map to a source entry. */
      unmapped: string
    }

/**
 * The one migration hook for each provider (phase 2 adds them): turn the
 * existing connections of an org into source bindings.
 */
export type SourceMigrationHook = {
  provider: SourceProvider
  listLegacyBindings(input: {
    orgId: string
    env: Env
  }): Promise<LegacySourceBinding[]>
  /**
   * Optional. Turn off the legacy sync of a migrated connection, so only the
   * Workspace sources sync writes its content. It runs when a source of the
   * connection first projects as `ok` in the Workspace whose repository is
   * {@link legacyRepositoryUrl}, after the migration PR merges.
   */
  disableLegacy?(input: { orgId: string; connectionId: string }): Promise<void>
  /** The git URL of the old sync repository of a connection, or null. */
  legacyRepositoryUrl?(input: {
    orgId: string
    connectionId: string
  }): Promise<string | null>
  /**
   * Optional. Move the old mirror files into the new managed paths in the
   * migration commit (`--apply`), by blob sha, so git keeps their history.
   * It runs only for a Workspace whose repository is the old sync
   * repository. `read` gives the text of one file.
   */
  legacyMoves?(input: {
    files: ReadonlyArray<{ path: string; sha: string }>
    read: (path: string) => Promise<string | null | undefined>
  }): Promise<Array<{ from: string; to: string; sha: string }>>
}

export const SOURCE_MIGRATION_HOOKS: Partial<
  Record<SourceProvider, SourceMigrationHook>
> = {
  confluence: confluenceSourceMigrationHook,
  linear: linearSourceMigrationHook,
  notion: notionSourceMigrationHook,
  pagerduty: pagerdutySourceMigrationHook,
  slack: slackSourceMigrationHook,
}

export type MigrationWorkspace = {
  id: string
  workspaceRepositoryUrl: string
  githubConnectionId: string | null
  /** The current `.ctxpipe/sources.yaml`, or null when absent. */
  sourcesFile: string | null
  /** The `repositories/*.md` files of the Workspace repository. */
  repositoryFiles?: ReadonlyArray<{ path: string; content: string }>
}

export type SourceMigrationReport = {
  moved: Array<{
    workspaceId: string
    provider: SourceProvider
    connectionId: string
  }>
  alreadyPresent: Array<{
    workspaceId: string
    provider: SourceProvider
    connectionId: string
  }>
  unmapped: Array<{
    provider: SourceProvider
    connectionId: string | null
    workspaceId: string | null
    reason: string
  }>
}

function existingPairs(text: string | null): Set<string> {
  if (!text) return new Set()
  try {
    const file = sourcesFileSchema.safeParse(parseSourcesYaml(text))
    if (!file.success) return new Set()
    return new Set(
      file.data.sources.flatMap((raw) => {
        const parsed = parseSourceEntry(raw)
        return parsed.ok
          ? [`${parsed.entry.provider}:${parsed.entry.connectionId}`]
          : []
      }),
    )
  } catch {
    return new Set()
  }
}

/**
 * Plan the migration of an org: for each Workspace, the source entries to add
 * to its `.ctxpipe/sources.yaml`. A connection maps to each Workspace whose
 * own repository or linked repositories include its old sync repository.
 * GitHub linked repositories become one GitHub source of the Workspace.
 * Running the plan again after the PRs merge adds nothing.
 */
export function planSourceMigration(input: {
  workspaces: readonly MigrationWorkspace[]
  linked: ReadonlyArray<{ workspaceId: string; gitUrl: string }>
  bindings: readonly LegacySourceBinding[]
}): {
  changes: Map<string, SourceChange[]>
  /** The repository files that the GitHub source replaces, per Workspace. */
  deletePaths: Map<string, string[]>
  report: SourceMigrationReport
} {
  const report: SourceMigrationReport = {
    moved: [],
    alreadyPresent: [],
    unmapped: [],
  }
  const changes = new Map<string, SourceChange[]>()
  const present = new Map(
    input.workspaces.map((workspace) => [
      workspace.id,
      existingPairs(workspace.sourcesFile),
    ]),
  )
  const add = (
    workspaceId: string,
    change: Extract<SourceChange, { action: "add" }>,
  ) => {
    const pair = `${change.provider}:${change.connectionId}`
    const item = {
      workspaceId,
      provider: change.provider,
      connectionId: change.connectionId,
    }
    if (present.get(workspaceId)?.has(pair)) {
      report.alreadyPresent.push(item)
      return false
    }
    present.get(workspaceId)?.add(pair)
    changes.set(workspaceId, [...(changes.get(workspaceId) ?? []), change])
    report.moved.push(item)
    return true
  }

  // The well-formed `repositories/*.md` files of each Workspace. They link
  // repositories too, until this migration moves them into the file.
  const repositoryFiles = new Map(
    input.workspaces.map((workspace) => [
      workspace.id,
      (workspace.repositoryFiles ?? []).flatMap((file) => {
        const parsed = parseLinkedRepositoryMarkdown(file.content)
        return parsed.malformed
          ? []
          : [
              {
                path: file.path,
                gitUrl: normalizeWorkspaceRepositoryUrl(parsed.git),
                branch: parsed.branch,
              },
            ]
      }),
    ]),
  )
  const linkedByWorkspace = new Map<string, string[]>()
  for (const link of [
    ...input.linked,
    ...[...repositoryFiles].flatMap(([workspaceId, files]) =>
      files.map((file) => ({ workspaceId, gitUrl: file.gitUrl })),
    ),
  ])
    linkedByWorkspace.set(link.workspaceId, [
      ...(linkedByWorkspace.get(link.workspaceId) ?? []),
      normalizeWorkspaceRepositoryUrl(link.gitUrl),
    ])

  for (const binding of input.bindings) {
    if ("unmapped" in binding) {
      report.unmapped.push({
        provider: binding.provider,
        connectionId: binding.connectionId,
        workspaceId: null,
        reason: binding.unmapped,
      })
      continue
    }
    const target = normalizeWorkspaceRepositoryUrl(binding.syncRepositoryUrl)
    const workspaces = input.workspaces.filter(
      (workspace) =>
        normalizeWorkspaceRepositoryUrl(workspace.workspaceRepositoryUrl) ===
          target ||
        (!binding.ownRepositoryOnly &&
          linkedByWorkspace.get(workspace.id)?.includes(target)),
    )
    if (!workspaces.length) {
      report.unmapped.push({
        provider: binding.provider,
        connectionId: binding.connectionId,
        workspaceId: null,
        reason: "No Workspace uses or links the old sync repository",
      })
      continue
    }
    for (const workspace of workspaces)
      add(workspace.id, {
        action: "add",
        provider: binding.provider,
        connectionId: binding.connectionId,
        scope: binding.scope,
      })
  }

  const deletePaths = new Map<string, string[]>()
  for (const workspace of input.workspaces) {
    // Each GitHub repository file becomes an item of the GitHub source, with
    // its branch as `ref`. A file for another host stays: only GitHub links.
    const files = (repositoryFiles.get(workspace.id) ?? []).flatMap((file) => {
      const name = githubRepoFullNameFromWorkspaceUrl(file.gitUrl)
      return name ? [{ ...file, name }] : []
    })
    if (!files.length) continue
    if (!workspace.githubConnectionId) {
      report.unmapped.push({
        provider: "github",
        connectionId: null,
        workspaceId: workspace.id,
        reason:
          "The Workspace links GitHub repositories but has no GitHub connection",
      })
      continue
    }
    const items = new Map<string, string | { name: string; ref: string }>()
    for (const file of files)
      if (!items.has(file.name.toLowerCase()))
        items.set(
          file.name.toLowerCase(),
          file.branch ? { name: file.name, ref: file.branch } : file.name,
        )
    const added = add(workspace.id, {
      action: "add",
      sourceKey: "linked-repositories",
      provider: "github",
      connectionId: workspace.githubConnectionId,
      scope: {
        repositories: [...items]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, item]) => item),
      },
    })
    // Delete the files only in the PR that adds the source.
    if (added)
      deletePaths.set(
        workspace.id,
        files.map((file) => file.path),
      )
  }
  return { changes, deletePaths, report }
}
