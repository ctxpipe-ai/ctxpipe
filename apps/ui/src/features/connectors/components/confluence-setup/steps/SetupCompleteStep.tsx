import { Button } from "@/components/ui/Button"

type SetupCompleteStepProps = {
  onClose: () => void
}

export function SetupCompleteStep({ onClose }: SetupCompleteStepProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Confluence is connected
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Confluence is linked and the Forge app is installed. Add Confluence to
          a Workspace from the connector card, or change the spaces of a
          Workspace in its settings.
        </p>
      </div>
      <Button variant="secondary" className="rounded-md" onPress={onClose}>
        Close
      </Button>
    </div>
  )
}
