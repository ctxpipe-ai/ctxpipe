import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"

export function OrgOutletError(props: {
  title: string
  error: unknown
  reset?: () => void
}) {
  const message =
    props.error instanceof Error && props.error.message.trim().length > 0
      ? props.error.message
      : "Try again in a moment."

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
        {message}
      </InlineAlert>
    </main>
  )
}
