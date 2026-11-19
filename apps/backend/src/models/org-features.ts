import { and, eq } from "drizzle-orm"

import { withOrgDbContext } from "../db/client.js"
import { orgFeatures } from "../db/schema/org_features.js"
import { log } from "../observability/logger.js"

/** The permitted values of each feature. The first value is the default. */
const FEATURE_VALUES = {
  knowledge_plane: ["off", "shadow", "on"],
} as const

type OrgFeature = keyof typeof FEATURE_VALUES
type OrgFeatureValue<F extends OrgFeature> = (typeof FEATURE_VALUES)[F][number]

/**
 * The value of a feature for an org. No row, or a value that is not permitted,
 * gives the default.
 */
export async function getOrgFeature<F extends OrgFeature>(
  orgId: string,
  feature: F,
): Promise<OrgFeatureValue<F>> {
  const permitted: readonly string[] = FEATURE_VALUES[feature]
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({ value: orgFeatures.value })
      .from(orgFeatures)
      .where(
        and(
          eq(orgFeatures.organizationId, orgId),
          eq(orgFeatures.feature, feature),
        ),
      )
      .limit(1),
  )
  if (!row) return permitted[0] as OrgFeatureValue<F>
  if (!permitted.includes(row.value)) {
    log.warn({
      step: "org_features.invalid_value",
      message:
        "org feature has a value that is not permitted; using the default",
      orgId,
      feature,
      value: row.value,
    })
    return permitted[0] as OrgFeatureValue<F>
  }
  return row.value as OrgFeatureValue<F>
}
