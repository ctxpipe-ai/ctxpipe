import YAML from "yaml"
import {
  checkSourcePath,
  type ParsedSourceFile,
  parseSourceFrontMatter,
  SOURCE_FILE_MAX_BYTES,
  type SourceFile,
} from "./source-file.js"

/** A source file needs no aliases; this cap stops alias expansion bombs. */
const MAX_ALIAS_COUNT = 50

const FRONT_MATTER = /^---[ \t]*\r?\n((?:.*\n)*?)---[ \t]*(?:\r?\n|$)/

/**
 * Parse the text of the source file at `path` (relative to the Workspace
 * root folder). The result keeps the body byte for byte.
 */
export function parseSourceFile(path: string, text: string): ParsedSourceFile {
  const invalid = (detail: string): ParsedSourceFile => {
    const checked = checkSourcePath(path)
    return {
      ok: false,
      path,
      provider: checked.ok ? checked.provider : null,
      connectionId: null,
      detail,
    }
  }
  if (Buffer.byteLength(text, "utf8") > SOURCE_FILE_MAX_BYTES)
    return invalid(
      `The file is larger than ${SOURCE_FILE_MAX_BYTES / 1024} KiB`,
    )
  const match = FRONT_MATTER.exec(text)
  if (!match)
    return invalid(
      "The file must start with a YAML front matter between --- lines",
    )
  const body = text.slice(match[0].length)
  const document = YAML.parseDocument(match[1] ?? "")
  if (document.errors.length)
    return invalid(
      `The front matter is not valid YAML: ${document.errors[0]?.message}`,
    )
  let data: unknown
  try {
    data = document.toJS({ maxAliasCount: MAX_ALIAS_COUNT }) ?? {}
  } catch (error) {
    return invalid(
      `The front matter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return parseSourceFrontMatter(path, data, body)
}

/**
 * The text of a source file: the front matter from `source`, then `body`
 * byte for byte. ctx| never changes the body, which people own.
 */
export function renderSourceFile(source: SourceFile, body: string): string {
  const frontMatter = YAML.stringify(
    {
      provider: source.provider,
      connection: source.connectionId,
      ...source.scope,
    },
    { lineWidth: 0 },
  )
  return `---\n${frontMatter}---\n${body}`
}
