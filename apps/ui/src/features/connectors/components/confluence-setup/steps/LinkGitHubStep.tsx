import { GitHubPrerequisiteStep } from "../../GitHubPrerequisiteStep"

type LinkGitHubStepProps = {
  orgSlug: string
  onConnected?: () => void | Promise<void>
}

export function LinkGitHubStep({ orgSlug, onConnected }: LinkGitHubStepProps) {
  return (
    <GitHubPrerequisiteStep
      orgSlug={orgSlug}
      sourceName="Confluence"
      onConnected={onConnected}
    />
  )
}
