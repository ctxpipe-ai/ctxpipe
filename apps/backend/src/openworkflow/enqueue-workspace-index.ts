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
  },
  log: { error: (err: Error) => void },
): Promise<void> {
  try {
    await runWorkflowWithWorkerWake(workspaceIndex.spec, input)
  } catch (err: unknown) {
    log.error(err instanceof Error ? err : new Error(String(err)))
  }
}
