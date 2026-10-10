import {
  type Alias,
  type Document,
  isAlias,
  isNode,
  type Node,
  parseDocument,
  visit,
} from "yaml"

/** Detach an alias while retaining the comments attached to its use site. */
export function materializeMetadataAlias(
  document: Document,
  alias: Alias,
): Node {
  const node = document.createNode(alias.toJS(document))
  node.comment = alias.comment
  node.commentBefore = alias.commentBefore
  return node
}

/** Keep references to values whose anchor disappears with a removed field. */
export function removeMetadataKey(document: Document, key: string): void {
  const removed = document.get(key, true)
  if (isNode(removed)) {
    const removedNodes = new Set<Node>()
    visit(removed, {
      Node: (_key, node) => {
        removedNodes.add(node)
      },
    })
    const replacements = new Map<Alias, Node>()
    visit(document, {
      Alias: (_key, alias) => {
        const target = alias.resolve(document)
        if (!target || !removedNodes.has(target)) return
        const replacement = materializeMetadataAlias(document, alias)
        replacements.set(alias, replacement)
      },
    })
    visit(document, { Alias: (_key, alias) => replacements.get(alias) })
  }
  document.delete(key)
}

/** Detach an aliased value so editing it does not mutate another metadata field. */
export function editableMetadataNode(document: Document, key: string) {
  const node = document.get(key, true)
  if (!isAlias(node)) return node
  const detached = materializeMetadataAlias(document, node)
  document.set(key, detached)
  return detached
}

/** Mutate selected YAML nodes while preserving other metadata and body bytes. */
export function updateKnowledgeMetadata(
  raw: string,
  edit: (document: ReturnType<typeof parseDocument>) => void,
): string {
  const frontMatter =
    /^(\uFEFF?---[ \t]*\r?\n)((?:[\s\S]*?\r?\n)?)(---[ \t]*(?=\r?\n|$))([\s\S]*)$/.exec(
      raw,
    )
  const document = parseDocument(frontMatter?.[2] ?? "")
  if (document.errors.length)
    throw new Error("Cannot rewrite malformed knowledge metadata")
  edit(document)
  if (frontMatter) {
    const newline = frontMatter[1]?.endsWith("\r\n") ? "\r\n" : "\n"
    const metadata = document.toString().replace(/\r?\n/g, newline)
    return `${frontMatter[1]}${metadata}${frontMatter[3]}${frontMatter[4]}`
  }
  return `---\n${document.toString()}---\n${raw}`
}
