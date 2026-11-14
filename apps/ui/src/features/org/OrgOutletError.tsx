import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { ApiError } from "@/lib/api-result"
import { hideSecrets } from "@/lib/hide-secrets"

/**
 * What went wrong, in one short sentence that does not repeat the title. The
 * status says where the request failed: the client fallback message of a
 * query ("Failed to load …") only says the title again.
 */
function errorSummary(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return "ctxpipe could not reach the server. Check your network connection."
    }
    if (error.status >= 500) {
      return `The server had an error (status ${error.status}).`
    }
    return `The server refused the request (status ${error.status}).`
  }
  return "ctxpipe had an error while it loaded this page."
}

/**
 * The raw reason (a server reason or an error message), or null. It can be
 * long machine text, so it shows in a small capped block, without the
 * secret-like values (R5).
 */
function rawReason(error: unknown): string | null {
  const reason =
    error instanceof ApiError
      ? (error.body.error ?? error.body.message)
      : error instanceof Error
        ? error.message
        : null
  return reason?.trim() ? hideSecrets(reason) : null
}

export function OrgOutletError(props: {
  title: string
  error: unknown
  reset?: () => void
}) {
  const requestId =
    props.error instanceof ApiError ? props.error.requestId : undefined
  const reason = rawReason(props.error)

  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <InlineAlert
        variant="error"
        title={props.title}
        actionsPlacement="end"
        actions={
          props.reset ? (
            <Button variant="secondary" onPress={props.reset}>
              Try again
            </Button>
          ) : undefined
        }
      >
        <p>{errorSummary(props.error)}</p>
        {reason ? (
          <p className="mt-2 max-h-24 overflow-y-auto rounded-md bg-red-950/60 px-2 py-1.5 font-mono text-xs wrap-anywhere text-red-100">
            {reason}
          </p>
        ) : null}
        <p className="mt-1 text-red-200">
          {props.reset ? "Try again in a moment." : "Reload the page."}
          {requestId
            ? " If the error stays, give this request ID to the ctxpipe team:"
            : props.reset
              ? " If the error stays, reload the page."
              : null}
        </p>
        {requestId ? (
          <p className="mt-2">
            <code className="font-mono text-xs text-red-50">{requestId}</code>
          </p>
        ) : null}
      </InlineAlert>
    </main>
  )
}
