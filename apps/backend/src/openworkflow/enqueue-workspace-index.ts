import { assertNotInOrgDbContext } from "../db/client.js"
import type { WorkspaceRevision } from "../domain/workspaces/revision.js"
import { parseEnv } from "../config/env.js"
import { resolveWorkspaceReadRevision } from "../domain/workspaces/resolve-revision.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { workspaceIndex } from "./workflows/workspace-index.js"

export async function enqueueWorkspaceIndex(
  input: {
    orgId: string
    workspaceId: string
    gitUrl: string
    desiredSha: string
    role: "workspace" | "linked"
    linkedId?: string
    jobGeneration: number
    jobWorkspaceUrl: string
    revision?: WorkspaceRevision
  },
  log: { error: (err: Error) => void },
): Promise<void> {
  assertNotInOrgDbContext()
  try {
    const resolved = await resolveWorkspaceReadRevision({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      env: parseEnv(process.env),
      expected: input.revision ?? {
        generation: input.jobGeneration,
        url: input.jobWorkspaceUrl,
        ...(input.role === "workspace" ? { sha: input.desiredSha } : {}),
      },
    })
    if (!resolved) return
    await runWorkflowWithWorkerWake(workspaceIndex.spec, {
      ...input,
      revision: resolved.revision,
    })
  } catch (err: unknown) {
    log.error(err instanceof Error ? err : new Error(String(err)))
  }
}
