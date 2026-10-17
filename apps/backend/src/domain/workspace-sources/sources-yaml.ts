import YAML, { type Document } from "yaml"

/** The largest `.ctxpipe/sources.yaml` that ctx| reads (256 KiB). */
export const SOURCES_FILE_MAX_BYTES = 256 * 1024
/** A sources file needs no aliases; this cap stops alias expansion bombs. */
const MAX_ALIAS_COUNT = 50

/** Parse the sources file as a YAML document, with a size and alias limit. */
export function parseSourcesDocument(text: string): Document.Parsed {
  if (Buffer.byteLength(text, "utf8") > SOURCES_FILE_MAX_BYTES)
    throw new Error(
      `The file is larger than ${SOURCES_FILE_MAX_BYTES / 1024} KiB`,
    )
  const document = YAML.parseDocument(text)
  if (document.errors.length)
    throw new Error(
      `The file is not valid YAML: ${document.errors[0]?.message}`,
    )
  // toJS enforces the alias cap.
  document.toJS({ maxAliasCount: MAX_ALIAS_COUNT })
  return document
}

/** Parse the sources file to plain data, with the same limits. */
export function parseSourcesYaml(text: string): unknown {
  return parseSourcesDocument(text).toJS({ maxAliasCount: MAX_ALIAS_COUNT })
}
