import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"

export function InviteWrongAccountNotice({
  sessionEmail,
  invitationEmail,
  signOutHref,
}: {
  sessionEmail: string
  invitationEmail: string
  signOutHref: string
}) {
  return (
    <div className="grid gap-4">
      <InlineAlert variant="warning" title="Signed in with a different account">
        <p>
          This invitation is for{" "}
          <span className="font-mono">{invitationEmail}</span>. You&apos;re
          signed in as <span className="font-mono">{sessionEmail}</span>.
        </p>
      </InlineAlert>
      <Button
        variant="primary"
        className="w-full rounded-none"
        onPress={() => {
          window.location.assign(signOutHref)
        }}
      >
        Sign out to continue
      </Button>
    </div>
  )
}
