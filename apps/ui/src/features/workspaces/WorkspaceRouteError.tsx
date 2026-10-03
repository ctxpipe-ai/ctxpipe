import { Link } from "@tanstack/react-router"

/** Route-level error UI when workspace loaders / suspense queries fail. */
export function WorkspaceRouteError(props: {
  error: unknown
  reset?: () => void
}) {
  const message =
    props.error instanceof Error && props.error.message.trim().length > 0
      ? props.error.message
      : "Could not load this Workspace."

  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
        Workspace
      </p>
      <h1 className="mt-3 text-xl font-medium tracking-tight">
        Something went wrong
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">{message}</p>
      <p className="mt-6 flex gap-4">
        {props.reset ? (
          <button
            type="button"
            onClick={props.reset}
            className="text-sm text-teal-400 hover:text-teal-300 hover:underline"
          >
            Try again
          </button>
        ) : null}
        <Link
          to="/"
          search={{
            error: undefined,
            error_description: undefined,
            pendingAccountClaim: undefined,
          }}
          className="text-sm text-teal-400 no-underline hover:text-teal-300 hover:underline"
        >
          Go to home
        </Link>
      </p>
    </main>
  )
}
