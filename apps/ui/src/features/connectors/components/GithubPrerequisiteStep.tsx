import { useNavigate } from "@tanstack/react-router"
import { Button } from "@/components/ui/Button"

type GithubPrerequisiteStepProps = {
  orgSlug: string
  sourceName: string
}

export function GithubPrerequisiteStep({
  orgSlug,
  sourceName,
}: GithubPrerequisiteStepProps) {
  const navigate = useNavigate()
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Link GitHub account
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {sourceName} content syncs to a GitHub repository. Connect GitHub and
          grant repository access from the repositories page.
        </p>
      </div>
      <Button
        variant="primary"
        className="rounded-none"
        onPress={() => {
          void navigate({ to: "/$orgSlug/repositories", params: { orgSlug } })
        }}
      >
        Go to repositories
      </Button>
    </div>
  )
}
