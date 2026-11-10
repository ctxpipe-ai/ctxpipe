import { sql } from "drizzle-orm"
import { expect } from "vitest"

import { getSystemDb } from "../db/client.js"

/**
 * No Workspace write step keeps a file or a Git object in its durable output
 * (CTX-1235, CTX-1239): each completed step output of a write workflow of the
 * org is at most 4 KiB. `withNativeHydrationFixture` checks it after each
 * test.
 */
export async function expectSmallWriteStepOutputs(orgId: string) {
  const large = await getSystemDb().execute(sql`
    select wr.workflow_name, sa.step_name, octet_length(sa.output::text) as bytes
    from openworkflow.step_attempts sa
    join openworkflow.workflow_runs wr on wr.id = sa.workflow_run_id
    where wr.input->>'orgId' = ${orgId}
      and wr.workflow_name like 'workspace-write-%'
      and sa.status = 'completed'
      and octet_length(sa.output::text) > 4096`)
  expect(large.rows).toEqual([])
}
