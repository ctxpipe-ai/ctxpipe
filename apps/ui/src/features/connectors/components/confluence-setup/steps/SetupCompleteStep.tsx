import { Button } from "@/components/ui/Button"

type SetupCompleteStepProps = {
  onClose: () => void
}

export function SetupCompleteStep({ onClose }: SetupCompleteStepProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-zinc-100">
          Confluence is connected
        </h3>
        <p className="mt-2 text-sm text-zinc-400">
          Sync target is set. Configure which spaces and pages to ingest from
          the connectors page, or close this dialog.
        </p>
      </div>
      <Button variant="secondary" onPress={onClose}>
        Close
      </Button>
    </div>
  )
}
