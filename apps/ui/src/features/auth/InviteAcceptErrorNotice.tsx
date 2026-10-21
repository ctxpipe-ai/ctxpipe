import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { InviteWrongAccountNotice } from "./InviteWrongAccountNotice"
import { inviteSignInHref, inviteSignOutHref } from "./invite-accept-decision"
import type { InviteAcceptError } from "./invite-accept-error"

/** A failed invitation accept: what happened and the next step. */
export function InviteAcceptErrorNotice({
  error,
  invitationId,
  invitationEmail,
  sessionEmail,
  onRetry,
}: {
  error: InviteAcceptError
  invitationId: string
  invitationEmail?: string | null
  sessionEmail?: string | null
  onRetry: () => void
}) {
  if (error.kind === "account-exists") {
    return (
      <div className="grid gap-4">
        <InlineAlert variant="warning" title="You already have an account">
          <p>
            This email already has a ctxpipe account. Sign in to accept the
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
  // The page checks the signed-in email first, so this is a safety net.
  if (error.kind === "wrong-recipient" && sessionEmail && invitationEmail) {
    return (
      <InviteWrongAccountNotice
        sessionEmail={sessionEmail}
        invitationEmail={invitationEmail}
        signOutHref={inviteSignOutHref(invitationId, invitationEmail)}
      />
    )
  }
  if (error.kind !== "failed") {
    return (
      <div className="grid gap-4">
        <InlineAlert
          variant="warning"
          title="We could not accept this invitation"
        >
          <p>
            Ask an admin of the organization for help, or for a new invitation.
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
