import { Button } from "@/components/ui/Button"
import { SuccessIcon } from "@/components/ui/SuccessIcon"

type InstallSuccessStepProps = {
  onContinue: () => void
}

export function InstallSuccessStep({ onContinue }: InstallSuccessStepProps) {
  return (
    <div className="flex flex-col items-center justify-center py-6 text-center">
      <div className="rounded-full bg-emerald-500/10 p-4">
        <SuccessIcon className="size-12 text-emerald-500" />
      </div>
      <h3 className="mt-4 text-lg font-semibold text-zinc-100">
        Connector installed successfully!
      </h3>
      <p className="mt-2 max-w-sm text-sm text-zinc-400">
        The Atlassian connector is now active. Continue to select where your
        Confluence content will be synced.
      </p>
      <Button className="mt-6" variant="primary" onPress={onContinue}>
        Continue
      </Button>
    </div>
  )
}
