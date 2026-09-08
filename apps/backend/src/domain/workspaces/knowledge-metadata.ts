import { parseDocument } from "yaml"

/** Mutate selected YAML nodes while preserving other metadata and body bytes. */
export function updateKnowledgeMetadata(
  raw: string,
  edit: (document: ReturnType<typeof parseDocument>) => void,
): string {
  const frontMatter = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/.exec(
    raw,
  )
  const document = parseDocument(frontMatter?.[2] ?? "")
  if (document.errors.length)
    throw new Error("Cannot rewrite malformed knowledge metadata")
  edit(document)
  if (frontMatter) {
    const newline = frontMatter[1]?.endsWith("\r\n") ? "\r\n" : "\n"
    const metadata = document.toString().trimEnd().replace(/\r?\n/g, newline)
    return `${frontMatter[1]}${metadata}${frontMatter[3]}${frontMatter[4]}`
  }
  return `---\n${document.toString()}---\n\n${raw}`
}
