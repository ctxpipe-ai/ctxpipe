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
