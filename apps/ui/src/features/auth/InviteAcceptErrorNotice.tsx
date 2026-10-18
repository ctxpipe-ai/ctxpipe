import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { inviteSignInHref, inviteSignOutHref } from "./invite-accept-decision"
import type { InviteAcceptError } from "./invite-accept-error"

/** A failed invitation accept: what happened and the next step. */
export function InviteAcceptErrorNotice({
  error,
  invitationId,
  invitationEmail,
  onRetry,
}: {
  error: InviteAcceptError
  invitationId: string
  invitationEmail?: string | null
  onRetry: () => void
}) {
  if (error.kind === "account-exists") {
    return (
      <div className="grid gap-4">
        <InlineAlert variant="warning" title="You already have an account">
          <p>
            This email already has a ctx| account. Sign in to accept the
            invitation.
          </p>
        </InlineAlert>
        <Button
          variant="primary"
          className="w-full rounded-md"
          href={inviteSignInHref(invitationId, invitationEmail)}
        >
          Sign in
        </Button>
      </div>
    )
  }
  if (error.kind === "invitation-unavailable") {
    return (
      <div className="grid gap-4">
        <InlineAlert variant="warning" title="This invitation is not available">
          <p>
            The invitation expired, was already used, or was canceled. Ask an
            admin of the organization to send you a new invitation.
          </p>
        </InlineAlert>
        <Button
          variant="secondary"
          className="w-full rounded-md"
          href="/.auth/sign-in"
        >
          Go to sign in
        </Button>
      </div>
    )
  }
  if (error.kind === "wrong-recipient") {
    return (
      <div className="grid gap-4">
        <InlineAlert
          variant="warning"
          title="This invitation is for a different email"
        >
          <p>Sign out, then sign in with the email that got the invitation.</p>
        </InlineAlert>
        <Button
          variant="primary"
          className="w-full rounded-md"
          href={inviteSignOutHref(invitationId, invitationEmail)}
        >
          Sign out to continue
        </Button>
      </div>
    )
  }
  return (
    <div className="grid gap-4">
      <InlineAlert variant="error" title="We could not accept the invitation">
        <p>
          The connection or our server had a problem. Try again in a moment.
        </p>
      </InlineAlert>
      <Button variant="primary" className="w-full rounded-md" onPress={onRetry}>
        Try again
      </Button>
    </div>
  )
}
