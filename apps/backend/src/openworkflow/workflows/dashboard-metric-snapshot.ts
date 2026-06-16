import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import { recordDashboardMetricSnapshot } from "../../domain/dashboard.js"

const dashboardMetricSnapshotInputSchema = z.object({
  orgId: z.string().min(1),
  metricDate: z.string().date().optional(),
})

export const dashboardMetricSnapshot = defineWorkflow(
  {
    name: "dashboard-metric-snapshot",
    schema: dashboardMetricSnapshotInputSchema,
  },
  async ({ input, step }) => {
    await step.run({ name: "record-dashboard-metric-snapshot" }, () =>
      withOrgDbContext(input.orgId, () =>
        recordDashboardMetricSnapshot({
          orgId: input.orgId,
          metricDate: input.metricDate
            ? new Date(`${input.metricDate}T00:00:00.000Z`)
            : undefined,
        }),
      ),
    )

    return { orgId: input.orgId, metricDate: input.metricDate ?? null }
  },
)
