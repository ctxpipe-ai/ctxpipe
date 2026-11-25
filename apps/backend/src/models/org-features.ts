import { and, eq, sql } from "drizzle-orm"

import { withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { orgFeatures } from "../db/schema/org_features.js"
import { log } from "../observability/logger.js"

/** The permitted values of each feature. The first value is the default. */
export const FEATURE_VALUES = {
  knowledge_plane: ["off", "shadow", "on"],
} as const

type OrgFeature = keyof typeof FEATURE_VALUES
type OrgFeatureValue<F extends OrgFeature> = (typeof FEATURE_VALUES)[F][number]

function isPermitted<F extends OrgFeature>(
  feature: F,
  value: string,
): value is OrgFeatureValue<F> {
  return (FEATURE_VALUES[feature] as readonly string[]).includes(value)
}

/**
 * The value of a feature for an org. No row, or a value that is not permitted,
 * gives the default.
 */
export async function getOrgFeature<F extends OrgFeature>(
  orgId: string,
  feature: F,
): Promise<OrgFeatureValue<F>> {
  const fallback: OrgFeatureValue<F> = FEATURE_VALUES[feature][0]
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({ value: orgFeatures.value })
      .from(orgFeatures)
      .where(
        and(
          eq(orgFeatures.organizationId, orgId),
          eq(orgFeatures.feature, feature),
        ),
      ),
  )
  if (!row) return fallback
  if (isPermitted(feature, row.value)) return row.value
  log.warn({
    step: "org_features.invalid_value",
    message: "org feature has a value that is not permitted; using the default",
    orgId,
    feature,
    value: row.value,
  })
  return fallback
}

function isFeature(feature: string): feature is OrgFeature {
  return Object.hasOwn(FEATURE_VALUES, feature)
}

/**
 * Who sets a value. `config` is the hosted config (`src/db/set-org-feature.ts`,
 * once for each entry on each hosted update). `operator` is the
 * `admin.set-org-feature` job of the operator console, with the request and
 * the people who asked and approved.
 */
export type OrgFeatureSetter =
  | { source: "config" }
  | {
      source: "operator"
      requestId: string
      requestedBy: unknown
      approvedBy: string
    }

/**
 * Sets the value of a feature for an org. The feature and the value must be
 * in `FEATURE_VALUES`, and the org must exist.
 *
 * A value that an operator sets is held: the config does not change it, so
 * the next hosted update does not undo a fast `off`. The hold ends when the
 * config names the same value (the config PR that follows the operator's
 * change). When the value does not change, nothing is written, so a second
 * run keeps `updated_at`. Each call logs `org_features.set` as the audit
 * record.
 */
export async function setOrgFeature(
  orgId: string,
  feature: string,
  value: string,
  by: OrgFeatureSetter,
): Promise<{
  previous: string
  value: string
  changed: boolean
  held: boolean
}> {
  if (!isFeature(feature))
    throw new Error(`"${feature}" is not a known feature`)
  if (!isPermitted(feature, value))
    throw new Error(
      `"${value}" is not a permitted value of ${feature} (${FEATURE_VALUES[feature].join(", ")})`,
    )
  const result = await withOrgDbContext(orgId, async (db) => {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgId))
    if (!org) throw new Error(`There is no organization with id ${orgId}`)
    // FOR UPDATE locks nothing when there is no row yet, so a transaction lock
    // on the key puts two setters of the same feature in sequence.
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`org_features:${orgId}:${feature}`}, 0))`,
    )
    const [row] = await db
      .select({ value: orgFeatures.value, held: orgFeatures.held })
      .from(orgFeatures)
      .where(
        and(
          eq(orgFeatures.organizationId, orgId),
          eq(orgFeatures.feature, feature),
        ),
      )
    const previous = row?.value ?? FEATURE_VALUES[feature][0]
    const wasHeld = row?.held ?? false
    const held = by.source === "operator"
    if (by.source === "config" && wasHeld && previous !== value)
      return { previous, value: previous, changed: false, held: true }
    if (previous === value && wasHeld === held)
      return { previous, value, changed: false, held }
    await db
      .insert(orgFeatures)
      .values({ organizationId: orgId, feature, value, held })
      .onConflictDoUpdate({
        target: [orgFeatures.organizationId, orgFeatures.feature],
        set: { value, held, updatedAt: new Date() },
      })
    return { previous, value, changed: previous !== value, held }
  })
  const { source, ...actor } = by
  const refused = source === "config" && result.held
  const entry = {
    step: "org_features.set",
    message: refused
      ? "the config did not change an org feature that an operator set"
      : result.changed
        ? "an org feature changed"
        : "an org feature was set to its current value: nothing changed",
    orgId,
    feature,
    source,
    ...actor,
    ...result,
  }
  if (refused) log.warn(entry)
  else log.info(entry)
  return result
}
