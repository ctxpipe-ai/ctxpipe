import { sql } from "drizzle-orm"
import { expect } from "vitest"

import { getSystemDb } from "../db/client.js"

/**
 * No Workspace write step keeps Git objects in its durable output
 * (CTX-1235): each completed step output of a write workflow of the org is at
 * most 4 KiB. `withNativeHydrationFixture` checks it after each test.
 * Two kinds of step still hold the file contents of the change, which grow
 * with the change, not with the repository, and are not checked: a
 * transform (except `transform-connector-mirror-v2`, which returns paths)
 * and `capture-semantic-handoff` (the delta of a push that lost a race).
 * CTX-1239 removes them.
 */
export async function expectSmallWriteStepOutputs(orgId: string) {
  const large = await getSystemDb().execute(sql`
    select wr.workflow_name, sa.step_name, octet_length(sa.output::text) as bytes
    from openworkflow.step_attempts sa
    join openworkflow.workflow_runs wr on wr.id = sa.workflow_run_id
    where wr.input->>'orgId' = ${orgId}
      and wr.workflow_name like 'workspace-write-%'
      and sa.status = 'completed'
      and sa.step_name not like 'capture-semantic-handoff%'
      and (sa.step_name not like 'transform-%'
        or sa.step_name like 'transform-connector-mirror-v2%')
      and octet_length(sa.output::text) > 4096`)
  expect(large.rows).toEqual([])
}
