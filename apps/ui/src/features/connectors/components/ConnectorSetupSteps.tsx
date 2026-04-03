import { ProgressBar } from "@/components/ui/ProgressBar"

export type SetupStep = {
  id: "link" | "install" | "wait" | "select" | "github" | "target"
  label: string
}

type ConnectorSetupStepsProps = {
  steps: SetupStep[]
  currentStep: SetupStep["id"]
  completedSteps: Set<SetupStep["id"]>
}

export function ConnectorSetupSteps({
  steps,
  currentStep,
  completedSteps,
}: ConnectorSetupStepsProps) {
  const activeIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === currentStep),
  )
  const percentage = Math.round(((activeIndex + 1) / steps.length) * 100)

  return (
    <div className="space-y-3">
      <ProgressBar value={percentage} label="Setup progress" />
      <ol className="grid gap-2 sm:grid-cols-2">
        {steps.map((step, index) => {
          const isCurrent = step.id === currentStep
          const isDone = completedSteps.has(step.id)
          return (
            <li
              key={step.id}
              className={[
                "rounded-md border px-3 py-2 text-sm",
                isCurrent
                  ? "border-blue-500 bg-blue-500/10 text-zinc-100"
                  : isDone
                    ? "border-emerald-700 bg-emerald-900/20 text-zinc-200"
                    : "border-zinc-800 text-zinc-400",
              ].join(" ")}
            >
              <span className="mr-2 text-xs text-zinc-500">{index + 1}.</span>
              {step.label}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
