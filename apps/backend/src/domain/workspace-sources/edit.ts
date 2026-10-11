import YAML, { isMap, isSeq, type YAMLMap, type YAMLSeq } from "yaml"
import {
  parseSourceEntry,
  type SourceEntry,
  type SourceProvider,
  sourceEntryToObject,
  sourcesFileSchema,
} from "./sources-file.js"

export type SourceFileChange =
  | {
      action: "add"
      sourceKey?: string
      provider: SourceProvider
      connectionId: string
      scope: Record<string, unknown>
    }
  | {
      action: "edit"
      sourceKey: string
      provider: SourceProvider
      connectionId: string
      scope: Record<string, unknown>
    }
  | { action: "remove"; sourceKey: string }

export class SourceFileEditError extends Error {
  constructor(
    readonly reason: "invalid" | "not_found" | "conflict",
    message: string,
  ) {
    super(message)
  }
}

function entryKey(node: unknown): string | null {
  if (!isMap(node)) return null
  const id = (node as YAMLMap).get("id")
  return typeof id === "string" ? id : null
}

function freeKey(taken: ReadonlySet<string>, provider: string): string {
  if (!taken.has(provider)) return provider
  let suffix = 2
  while (taken.has(`${provider}-${suffix}`)) suffix++
  return `${provider}-${suffix}`
}

/**
 * Apply one source change to the text of `.ctxpipe/sources.yaml`. It keeps
 * the comments and the order of the other entries. `text` null means no file.
 */
export function applySourceFileChange(
  text: string | null,
  change: SourceFileChange,
): {
  text: string
  sourceKey: string
  /** The new entry, or null for a removal. */
  entry: SourceEntry | null
  /** The provider of the new or removed entry, when it is known. */
  provider: SourceProvider | null
} {
  const document = YAML.parseDocument(
    text?.trim() ? text : "version: 1\nsources: []\n",
  )
  if (document.errors.length)
    throw new SourceFileEditError(
      "conflict",
      `The sources file is not valid YAML: ${document.errors[0]?.message}`,
    )
  const file = sourcesFileSchema.safeParse(document.toJS())
  if (!file.success)
    throw new SourceFileEditError(
      "conflict",
      "The sources file does not match version 1. Fix it in git first.",
    )
  let sources = document.get("sources")
  if (!isSeq(sources)) {
    document.set("sources", document.createNode([]))
    sources = document.get("sources")
  }
  const items = (sources as YAMLSeq).items
  const keys = new Set(items.flatMap((node) => entryKey(node) ?? []))
  const index =
    change.action === "add"
      ? -1
      : items.findIndex((node) => entryKey(node) === change.sourceKey)

  if (change.action === "remove") {
    if (index < 0)
      throw new SourceFileEditError(
        "not_found",
        `No source has the id "${change.sourceKey}"`,
      )
    const removed = parseSourceEntry((items[index] as YAMLMap).toJSON())
    items.splice(index, 1)
    return {
      text: document.toString(),
      sourceKey: change.sourceKey,
      entry: null,
      provider: removed.ok ? removed.entry.provider : removed.provider,
    }
  }

  const sourceKey =
    change.action === "edit"
      ? change.sourceKey
      : (change.sourceKey ?? freeKey(keys, change.provider))
  if (change.action === "add" && keys.has(sourceKey))
    throw new SourceFileEditError(
      "conflict",
      `A source with the id "${sourceKey}" exists`,
    )
  if (change.action === "edit" && index < 0)
    throw new SourceFileEditError(
      "not_found",
      `No source has the id "${sourceKey}"`,
    )
  const parsed = parseSourceEntry(
    sourceEntryToObject({
      key: sourceKey,
      provider: change.provider,
      connectionId: change.connectionId,
      scope: change.scope,
    }),
  )
  if (!parsed.ok) throw new SourceFileEditError("invalid", parsed.detail)
  const node = document.createNode(sourceEntryToObject(parsed.entry))
  if (index < 0) items.push(node)
  else items[index] = node
  return {
    text: document.toString(),
    sourceKey,
    entry: parsed.entry,
    provider: parsed.entry.provider,
  }
}
