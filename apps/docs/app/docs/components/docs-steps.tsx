import type { ReactNode } from "react"

type DocsStepsProps = {
  children: ReactNode
}

export function Steps({ children }: DocsStepsProps) {
  return <div className="fd-steps docs-steps">{children}</div>
}

export function Step({ children }: DocsStepsProps) {
  return <div className="fd-step docs-step">{children}</div>
}
