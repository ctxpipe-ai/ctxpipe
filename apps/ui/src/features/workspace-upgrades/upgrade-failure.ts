import type { WorkspaceUpgradeItem } from "./queries"

export type UpgradeFailure = NonNullable<WorkspaceUpgradeItem["failure"]>

const STEP_LABEL: Record<NonNullable<UpgradeFailure["step"]>, string> = {
  plan: "Plan the re-ingestion",
  wait: "Wait for a turn",
  read_source: "Read the source repository",
  ingest: "Ingest the source repository",
  publish: "Publish to the Workspace",
}

/**
 * The fix for one failure class. `link`: a page where the user can do the
 * fix. `agent`: the card offers "Fix using agent". Else Start again is the
 * fix.
 */
type FailureCopy = {
  reason: string
  action: string
  link?: "connectors"
  linkLabel?: string
  agent?: true
}

const FAILURE_COPY: Record<UpgradeFailure["code"], FailureCopy> = {
  source_access: {
    reason:
      "ctx| cannot read a source repository. The GitHub App may have lost access to it, or the repository moved.",
    action:
      "Reconnect GitHub and give the App access to the repository, then start it again.",
    link: "connectors",
    linkLabel: "Reconnect GitHub",
  },
  workspace_write_access: {
    reason: "ctx| cannot write to the Workspace repository.",
    action:
      "Give the GitHub App write access to the Workspace repository, then start it again.",
    link: "connectors",
    linkLabel: "Open access settings",
  },
  sandbox: {
    reason: "The ingest sandbox stopped or did not start.",
    action:
      "Start it again. If it fails again, ask the operator of ctx| to check the sandbox provider.",
  },
  model: {
    reason: "The model provider returned an error.",
    action: "Wait a few minutes, then start it again.",
  },
  publish_conflict: {
    reason:
      "The Workspace changed while ctx| published, and ctx| could not merge the files.",
    action:
      "Start it again. The new run starts from the current Workspace content.",
  },
  timeout: {
    reason: "The run took longer than the upgrade waits.",
    action: "Start it again.",
  },
  too_many_sources: {
    reason:
      "The Workspace has more source repositories than one re-ingestion handles.",
    action: "Remove some source repositories, then start it again.",
  },
  repository_too_large: {
    reason:
      "A Git repository that this upgrade reads is too large for ctx| to read.",
    action:
      "Remove large files that are not knowledge, such as build output or binary files, from that repository. Then start it again.",
    agent: true,
  },
  unknown: {
    reason: "ctx| does not know the cause of this failure.",
    action: "Ask the agent to find the cause, or start it again.",
    agent: true,
  },
}

/** What the failure card shows: the step, the reason, the summary, and the fix. */
export function upgradeFailureCopy(failure: UpgradeFailure) {
  const copy = FAILURE_COPY[failure.code] ?? FAILURE_COPY.unknown
  const step = failure.step ? STEP_LABEL[failure.step] : null
  return {
    ...copy,
    step: step
      ? `${step}${failure.repository ? ` (${failure.repository})` : ""}`
      : null,
  }
}

/** The chat prompt of "Fix using agent" for a failed upgrade. */
export function upgradeFailurePrompt(
  item: Pick<WorkspaceUpgradeItem, "title">,
  failure: UpgradeFailure,
): string {
  const { step } = upgradeFailureCopy(failure)
  return `The upgrade "${item.title}" of this Workspace failed${step ? ` at the step "${step}"` : ""}. ctx| recorded: ${failure.summary} Find the cause, and tell me how to fix it.`
}
