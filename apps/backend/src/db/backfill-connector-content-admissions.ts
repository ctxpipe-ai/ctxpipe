import { defineWorkflowSpec, OpenWorkflow } from "openworkflow"
import type { BackendPostgres } from "openworkflow/postgres"
import type { Pool } from "pg"
import { z } from "zod"
import {
  activateConnectorSync,
  connectorContentBindingSchema,
  prepareConnectorSync,
} from "../models/connector-content-sync.js"

const legacyInput = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
})
const contentInput = legacyInput.extend({
  contentSyncGeneration: z.number().int().positive(),
  contentSyncBinding: connectorContentBindingSchema,
  configKey: z.string().min(1),
})
const scopeSchema = z.object({
  orgId: z.string().min(1),
  connectionIds: z.array(z.string().min(1)).min(1).max(100),
})
type RecoveryScope = z.infer<typeof scopeSchema>

/** Read-only preview for an explicit, bounded set of connectors in one organization. */
export async function previewConnectorContentAdmissions(
  pool: Pool,
  scope: RecoveryScope,
) {
  scopeSchema.parse(scope)
  const candidates = await pool.query<{
    id: string
    workflow_name:
      | "linear-sync-config"
      | "notion-sync-config"
      | "confluence-sync-config"
    input: unknown
  }>(
    `
    select distinct on (owner.input->>'connectionId') owner.id, owner.workflow_name, owner.input
    from openworkflow.workflow_runs owner
    where owner.input->>'orgId' = $1 and owner.input->>'connectionId' = any($2::text[])
      and owner.workflow_name in ('linear-sync-config', 'notion-sync-config', 'confluence-sync-config')
      and not (owner.input ? 'contentSyncBinding')
      and coalesce(owner.input->>'contentSyncGeneration', '0') = '0'
      and (owner.status <> 'completed' or owner.output->>'changed' = 'false')
      and not exists (
        select 1 from openworkflow.workflow_runs later
        where later.input->>'orgId' = owner.input->>'orgId'
          and later.input->>'connectionId' = owner.input->>'connectionId'
          and ((later.workflow_name = owner.workflow_name and (later.created_at, later.id) > (owner.created_at, owner.id))
            or (later.workflow_name = replace(owner.workflow_name, '-config', '-content') and later.created_at >= owner.created_at))
      )
    order by owner.input->>'connectionId', owner.created_at desc, owner.id desc
  `,
    [scope.orgId, scope.connectionIds],
  )
  const plans = []
  for (const owner of candidates.rows) {
    const parsed = legacyInput.safeParse(owner.input)
    if (!parsed.success) continue
    const provider =
      owner.workflow_name === "linear-sync-config"
        ? "linear"
        : owner.workflow_name === "notion-sync-config"
          ? "notion"
          : "confluence"
    const configKey = `legacy-config:${owner.id}`
    const intent = await prepareConnectorSync({
      ...parsed.data,
      provider,
      configKey,
      purpose: "content",
      legacyConfigRecovery: true,
    })
    if (intent)
      plans.push({
        provider,
        input: {
          ...parsed.data,
          configKey,
          contentSyncGeneration: intent.contentSyncGeneration,
          contentSyncBinding: intent.contentSyncBinding,
        },
      })
  }
  return plans
}

/** Explicitly invoked recovery only; never runs automatically during migration or startup. */
export async function backfillConnectorContentAdmissions(
  pool: Pool,
  backend: BackendPostgres,
  scope: RecoveryScope,
): Promise<void> {
  const runner = new OpenWorkflow({ backend })
  for (const plan of await previewConnectorContentAdmissions(pool, scope)) {
    const spec = defineWorkflowSpec<z.infer<typeof contentInput>>({
      name: `${plan.provider}-sync-content`,
      schema: contentInput,
    })
    const handle = await runner.runWorkflow(spec, plan.input, {
      idempotencyKey: `connector-content:${plan.input.connectionId}:${plan.input.contentSyncGeneration}:${plan.input.configKey}`,
    })
    await activateConnectorSync({
      ...plan.input,
      purpose: "content",
      workflowRunId: handle.workflowRun.id,
    })
  }
}
