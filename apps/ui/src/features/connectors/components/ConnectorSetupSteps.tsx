import { ProgressBar } from "@/components/ui/ProgressBar"

export type SetupStep = {
  id: "link" | "install" | "wait" | "select" | "github" | "target"
  label: string
}

type ConnectorSetupStepsProps = {
  steps: SetupStep[]
  currentStep: SetupStep["id"]
  isInstalled: boolean
}

export function ConnectorSetupSteps({
  steps,
  currentStep,
  isInstalled,
}: ConnectorSetupStepsProps) {
  const activeIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === currentStep),
  )
  const percentage = Math.round(((activeIndex + 1) / steps.length) * 100)

  // Don't show step indicator if installation is complete (success state or target config)
  if (isInstalled) {
    return null
  }

  const currentStepLabel = steps[activeIndex]?.label ?? "Setup"

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-zinc-400">Current step:</span>
        <span className="font-medium text-zinc-200">{currentStepLabel}</span>
      </div>
      <ProgressBar value={percentage} label={`Step ${activeIndex + 1} of ${steps.length}`} />
    </div>
  )
}
