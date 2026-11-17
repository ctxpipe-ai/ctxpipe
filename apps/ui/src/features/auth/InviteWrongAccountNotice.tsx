import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"

/**
 * The join organization card when the user is signed in with an email other
 * than the invited one: a warning with both emails and a button to sign out.
 * Use `InviteAcceptErrorNotice` for an accept that failed for another reason.
 */
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
        className="w-full rounded-md"
        onPress={() => {
          window.location.assign(signOutHref)
        }}
      >
        Sign out to continue
      </Button>
    </div>
  )
}
