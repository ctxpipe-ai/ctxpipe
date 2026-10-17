/*
 * The upgrade row keys, with no imports, so that hydrate can read the
 * upgrade rows without the step registry.
 */

/** The write job kind of an upgrade run. */
export const UPGRADE_JOB_KIND = "upgrade"

const REINGEST_KEY_PREFIX = "reingest-"

/** The key of the re-ingestion with a skill bundle (`ingest-<hash>`). */
export function reingestUpgradeKey(bundleName: string): string {
  return `${REINGEST_KEY_PREFIX}${bundleName}`
}

export function isReingestUpgradeKey(key: string): boolean {
  return key.startsWith(REINGEST_KEY_PREFIX)
}

/**
 * The source repositories (`owner/name`, lower case, sorted) that a
 * re-ingestion did, from upgrade payloads: their sticky `reingested` list and
 * each `done` repository in their reports.
 */
export function reingestedNames(
  ...payloads: ReadonlyArray<
    | {
        reingested?: readonly string[]
        repositories?: ReadonlyArray<{ repository: string; status: string }>
      }
    | null
    | undefined
  >
): string[] {
  const names = new Set<string>()
  for (const payload of payloads) {
    for (const name of payload?.reingested ?? []) names.add(name.toLowerCase())
    for (const report of payload?.repositories ?? [])
      if (report.status === "done") names.add(report.repository.toLowerCase())
  }
  return [...names].sort()
}
