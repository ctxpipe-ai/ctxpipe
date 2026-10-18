import { Component, type ReactNode } from "react"
import { WorkspaceRouteError } from "./WorkspaceRouteError"

export class WorkspaceQueryErrorBoundary extends Component<
  {
    children: ReactNode
    fallback?: (error: unknown, reset: () => void) => ReactNode
  },
  { error: unknown }
> {
  state: { error: unknown } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, () =>
          this.setState({ error: null }),
        )
      }
      return (
        <WorkspaceRouteError
          error={this.state.error}
          reset={() => this.setState({ error: null })}
        />
      )
    }
    return this.props.children
  }
}
