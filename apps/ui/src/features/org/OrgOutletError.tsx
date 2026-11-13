import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { ApiError } from "@/lib/api-result"

/**
 * What went wrong, in words that do not repeat the title. A server reason
 * wins. Without one, the status says where the request failed: the client
 * fallback message of a query ("Failed to load …") only says the title again.
 */
function errorDetail(error: unknown): string {
  if (error instanceof ApiError) {
    const reason = error.body.error ?? error.body.message
    if (reason?.trim()) return reason
    if (error.status === 0) {
      return "ctxpipe could not reach the server. Check your network connection."
    }
    if (error.status >= 500) {
      return `The server had an error (status ${error.status}).`
    }
    return `The server refused the request (status ${error.status}).`
  }
  if (error instanceof Error && error.message.trim()) return error.message
  return "ctxpipe gave no reason."
}

export function OrgOutletError(props: {
  title: string
  error: unknown
  reset?: () => void
}) {
  const requestId =
    props.error instanceof ApiError ? props.error.requestId : undefined

  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <InlineAlert
        variant="error"
        title={props.title}
        actions={
          props.reset ? (
            <Button variant="secondary" onPress={props.reset}>
              Try again
            </Button>
          ) : undefined
        }
      >
        <p>{errorDetail(props.error)}</p>
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
