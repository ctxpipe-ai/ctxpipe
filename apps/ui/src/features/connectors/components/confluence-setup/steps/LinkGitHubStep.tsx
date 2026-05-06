import { useNavigate } from "@tanstack/react-router"
import { Button } from "@/components/ui/Button"

type LinkGitHubStepProps = {
  orgSlug: string
}

export function LinkGitHubStep({ orgSlug }: LinkGitHubStepProps) {
  const navigate = useNavigate()
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-zinc-100">
          Link GitHub account
        </h3>
        <p className="mt-2 text-sm text-zinc-400">
          Confluence content syncs to a GitHub repository. Connect GitHub and
          grant repository access from the repositories page.
        </p>
      </div>
      <Button
        variant="primary"
        onPress={() => {
          void navigate({ to: "/$orgSlug/repositories", params: { orgSlug } })
        }}
      >
        Go to repositories
      </Button>
    </div>
  )
}
