import { type ErrorComponentProps, useRouter } from "@tanstack/react-router"
import { OrgOutletError } from "./OrgOutletError"

/**
 * Error screen of the org route when the org gate fails. `reset` only clears
 * the error boundary, and the match throws again. Try again also invalidates
 * the router, so that the loader runs again.
 */
export function OrgGateError({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <OrgOutletError
      title="Something went wrong"
      error={error}
      reset={() => {
        reset()
        void router.invalidate()
      }}
    />
  )
}
