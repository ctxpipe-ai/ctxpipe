import { GithubPrerequisiteStep } from "../../GithubPrerequisiteStep"

type LinkGitHubStepProps = {
  orgSlug: string
}

export function LinkGitHubStep({ orgSlug }: LinkGitHubStepProps) {
  return <GithubPrerequisiteStep orgSlug={orgSlug} sourceName="Confluence" />
}
