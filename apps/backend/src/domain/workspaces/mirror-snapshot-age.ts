import { splitFrontmatter } from "../codeIngestion/connectorFrontmatter.js"

/**
 * The front matter keys of the source update time. GitHub and Linear write
 * `updatedAt`, PagerDuty and Plain write `updated_at`, and Notion writes
 * `last_edited_time`.
 */
const UPDATE_TIME_KEYS = ["updatedAt", "updated_at", "last_edited_time"]

function updateTime(text: string): number | null {
  const data = splitFrontmatter(text)?.data
  for (const key of UPDATE_TIME_KEYS) {
    const value = data?.[key]
    if (typeof value !== "string") continue
    const time = Date.parse(value)
    return Number.isNaN(time) ? null : time
  }
  return null
}

/**
 * True when the mirror file on the tip is a snapshot of the same age as the
 * incoming file, or newer, so the incoming file must not replace it. A file
 * on the tip with Git conflict markers never stops the incoming file. When a
 * side has no update time that ctxpipe can read, the incoming file wins.
 */
export function tipMirrorSnapshotIsCurrent(
  incoming: string,
  onTip: string,
): boolean {
  if (/^(<{7}|>{7})( |$)/m.test(onTip)) return false
  const incomingTime = updateTime(incoming)
  const tipTime = updateTime(onTip)
  return incomingTime !== null && tipTime !== null && tipTime >= incomingTime
}
