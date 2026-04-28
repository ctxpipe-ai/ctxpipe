import { Button } from "@/components/ui/Button"

type SetupCompleteStepProps = {
  onClose: () => void
}

export function SetupCompleteStep({ onClose }: SetupCompleteStepProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-foreground">
          Confluence is connected
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Confluence is linked, the Forge app is installed, a sync target is
          set, and at least one space is in scope. You can close this dialog or
          manage scope anytime from the connector card.
        </p>
      </div>
      <Button variant="secondary" className="rounded-none" onPress={onClose}>
        Close
      </Button>
    </div>
  )
}
