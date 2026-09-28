"use client"

import { useId, useState } from "react"
import { emailDomain, parseInviteEmails } from "@/components/onboarding/invites"
import { OnboardingExternalInviteModal } from "@/components/onboarding/OnboardingExternalInviteModal"
import { authClient } from "@/lib/auth-client"

type OnboardingInviteSlideProps = {
  userEmail: string | undefined
  completing: boolean
  onCompleteOnboarding: () => Promise<void>
}

export function OnboardingInviteSlide({
  userEmail,
  completing,
  onCompleteOnboarding,
}: OnboardingInviteSlideProps) {
  const inviteEmailsFieldId = useId()
  const [inviteEmails, setInviteEmails] = useState("")
  const [inviteSent, setInviteSent] = useState(false)
  const [inviteSubmitting, setInviteSubmitting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [confirmExternalOpen, setConfirmExternalOpen] = useState(false)
  const [pendingExternalRecipients, setPendingExternalRecipients] = useState<
    string[]
  >([])

  const sendInvites = async () => {
    setInviteError(null)
    setInviteSubmitting(true)
    const recipients = parseInviteEmails(inviteEmails)
    try {
      for (const email of recipients) {
        await authClient.organization.inviteMember({
          email,
          role: "member",
          organizationId: undefined as unknown as string,
        })
      }
      setInviteSent(true)
    } catch {
      setInviteError("Failed to send invites. Please try again.")
    } finally {
      setInviteSubmitting(false)
    }
  }

  const handleSendInvites = async () => {
    if (inviteSubmitting || inviteSent) return
    const recipients = parseInviteEmails(inviteEmails)
    if (recipients.length === 0) {
      setInviteError("Add at least one valid email address.")
      return
    }
    const inviterDomain = emailDomain(userEmail ?? "")
    const externalRecipients = inviterDomain
      ? recipients.filter((email) => emailDomain(email) !== inviterDomain)
      : []
    if (externalRecipients.length > 0) {
      setPendingExternalRecipients(externalRecipients)
      setConfirmExternalOpen(true)
      return
    }
    await sendInvites()
  }

  return (
    <>
      <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
        Invite team members
      </h2>
      <div className="onb-in-2 mx-auto mb-10 max-w-3xl">
        <p className="mx-auto mb-4 text-zinc-300">
          ctx| is designed for your whole team and their agents. Invite some
          co-workers to test it out with.
        </p>
        <div className="mx-auto max-w-3xl rounded-none border border-border bg-zinc-950/70 p-6 text-left">
          <label
            className="mb-2 block text-sm text-zinc-200"
            htmlFor={inviteEmailsFieldId}
          >
            Email
          </label>
          <input
            id={inviteEmailsFieldId}
            type="text"
            value={inviteEmails}
            onChange={(e) => setInviteEmails(e.target.value)}
            placeholder="email@example.com, email2@example.com..."
            className="mb-4 h-11 w-full rounded-none border border-border bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-teal-400/60"
          />
          {inviteError ? (
            <p className="mb-4 text-xs text-red-400">{inviteError}</p>
          ) : null}
          <div className="flex justify-end">
            <button
              type="button"
              disabled={inviteSubmitting || inviteSent}
              className="inline-flex h-10 items-center justify-center rounded-none border border-border bg-zinc-100 px-5 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
              onClick={() => void handleSendInvites()}
            >
              {inviteSent
                ? "Invites sent"
                : inviteSubmitting
                  ? "Sending invites..."
                  : "Send invites"}
            </button>
          </div>
        </div>
        {inviteSent ? (
          <div className="mx-auto mt-4 max-w-3xl rounded-none border border-teal-400/40 bg-teal-400/10 px-4 py-3 text-sm text-teal-200">
            Invites sent to your team
          </div>
        ) : null}
        <div className="mt-8 flex flex-col items-center gap-8">
          {inviteSent ? (
            <button
              type="button"
              disabled={completing}
              className="inline-flex h-11 items-center justify-center rounded-none border border-border bg-zinc-100 px-6 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:opacity-50"
              onClick={() => void onCompleteOnboarding()}
            >
              {completing ? "Finishing..." : "Continue"}
            </button>
          ) : (
            <button
              type="button"
              disabled={completing}
              className="text-sm text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300"
              onClick={() => void onCompleteOnboarding()}
            >
              {completing ? "Finishing..." : "I\u2019ll do this later"}
            </button>
          )}
        </div>
      </div>

      <OnboardingExternalInviteModal
        isOpen={confirmExternalOpen}
        onOpenChange={setConfirmExternalOpen}
        pendingExternalRecipients={pendingExternalRecipients}
        onCancel={() => setPendingExternalRecipients([])}
        onConfirmSend={() => {
          void sendInvites()
          setPendingExternalRecipients([])
        }}
      />
    </>
  )
}
