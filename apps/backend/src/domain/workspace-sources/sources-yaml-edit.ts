import { isMap, isSeq, type YAMLMap, type YAMLSeq } from "yaml"
import { SourceChangeError } from "./edit.js"
import {
  parseSourceEntry,
  RESERVED_ENTRY_KEYS,
  type SourceEntry,
  type SourceProvider,
  sourceEntryToObject,
  sourceKeySchema,
  sourcesFileSchema,
} from "./sources-file.js"
import { parseSourcesDocument } from "./sources-yaml.js"

export type SourcesYamlChange =
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

/** Refuse a change whose key or scope cannot go into the file (400). */
export function assertSourcesYamlChangeShape(change: SourcesYamlChange): void {
  if (
    change.action !== "add" &&
    !sourceKeySchema.safeParse(change.sourceKey).success
  )
    throw new SourceChangeError(
      400,
      `The id "${change.sourceKey}" is not a valid source id. Fix it in git.`,
    )
  if (change.action !== "remove") {
    const reserved = Object.keys(change.scope).filter((name) =>
      RESERVED_ENTRY_KEYS.has(name),
    )
    if (reserved.length)
      throw new SourceChangeError(
        400,
        `The scope must not set ${reserved.join(", ")}`,
      )
  }
}

/**
 * Apply one source change to the text of `.ctxpipe/sources.yaml`. It keeps
 * the comments and the order of the other entries. `text` null means no file.
 */
export function applySourcesYamlChange(
  text: string | null,
  change: SourcesYamlChange,
  /** Ids that a new source must not get, beside the ids in the file. */
  reservedKeys: ReadonlySet<string> = new Set(),
): {
  text: string
  sourceKey: string
  /** The new entry, or null for a removal. */
  entry: SourceEntry | null
  /** The provider of the new or removed entry, when it is known. */
  provider: SourceProvider | null
} {
  assertSourcesYamlChangeShape(change)
  let document: ReturnType<typeof parseSourcesDocument>
  try {
    document = parseSourcesDocument(
      text?.trim() ? text : "version: 1\nsources: []\n",
    )
  } catch (error) {
    throw new SourceChangeError(
      409,
      `The sources file cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const file = sourcesFileSchema.safeParse(document.toJS())
  if (!file.success)
    throw new SourceChangeError(
      409,
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
      throw new SourceChangeError(
        404,
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
      : (change.sourceKey ??
        freeKey(new Set([...keys, ...reservedKeys]), change.provider))
  if (change.action === "add" && keys.has(sourceKey))
    throw new SourceChangeError(
      409,
      `A source with the id "${sourceKey}" exists`,
    )
  if (change.action === "add" && reservedKeys.has(sourceKey))
    throw new SourceChangeError(
      409,
      `An open pull request changes the source "${sourceKey}". Merge or close it first.`,
    )
  if (change.action === "edit" && index < 0)
    throw new SourceChangeError(404, `No source has the id "${sourceKey}"`)
  const parsed = parseSourceEntry(
    sourceEntryToObject({
      key: sourceKey,
      provider: change.provider,
      connectionId: change.connectionId,
      scope: change.scope,
    }),
  )
  if (!parsed.ok) throw new SourceChangeError(400, parsed.detail)
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
