import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ConnectorSetupStepper } from "./ConnectorSetupStepper"

const steps = [
  { id: "connect", label: "Connect workspace" },
  { id: "scope", label: "Configure scope" },
  { id: "merge", label: "Merge configuration" },
] as const

describe("ConnectorSetupStepper", () => {
  it("marks the first incomplete step as current", () => {
    const markup = renderToStaticMarkup(
      <ConnectorSetupStepper steps={steps} currentIndex={1} />,
    )

    expect(markup).toContain('data-state="done"')
    expect(markup).toContain('data-state="current"')
    expect(markup).toContain('aria-current="step"')
  })

  it("marks every step complete when current index equals step count", () => {
    const markup = renderToStaticMarkup(
      <ConnectorSetupStepper steps={steps} currentIndex={steps.length} />,
    )

    expect(markup).not.toContain('data-state="current"')
    expect(markup.match(/data-state="done"/g)).toHaveLength(steps.length)
  })
})
