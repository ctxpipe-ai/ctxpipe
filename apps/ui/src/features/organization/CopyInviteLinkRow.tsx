"use client"

import type { SettingsCardProps } from "@daveyplate/better-auth-ui"
import {
  AuthUIContext,
  useCurrentOrganization,
} from "@daveyplate/better-auth-ui"
import type { Organization } from "better-auth/plugins/organization"
import { Loader2 } from "lucide-react"
import { type FormEvent, useCallback, useContext, useState } from "react"
import { Button } from "@/components/ui/Button"
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog"
import { Input } from "@/components/ui/input"
import { Modal } from "@/components/ui/Modal"
import { buildOrganizationInviteLink } from "@/features/organization/buildOrganizationInviteLink"
import { cn } from "@/lib/utils"

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "object" && error != null) {
    const maybeMessage = (error as { message?: unknown }).message
    if (typeof maybeMessage === "string" && maybeMessage.length > 0) {
      return maybeMessage
    }
  }
  return "Request failed. Please try again."
}

function isAlreadyInvitedError(error: unknown): boolean {
  const s = extractErrorMessage(error)
  return /already invited|USER_IS_ALREADY_INVITED/i.test(s)
}

type InvitationPayload = { id: string; email: string }

export function CopyInviteLinkRow({
  slug: slugProp,
  classNames,
}: {
  slug?: string
  classNames?: SettingsCardProps["classNames"]
}) {
  const {
    authClient,
    hooks: {
      useHasPermission,
      useListInvitations,
      useListMembers,
      useSession,
      useListTeams,
    },
    localization,
    organization: organizationOptions,
    teams: teamOptions,
    toast,
  } = useContext(AuthUIContext)

  const slug = slugProp || organizationOptions?.slug
  const { enabled: teamsEnabled } = teamOptions || {}

  const { data: organization } = useCurrentOrganization({ slug })

  const orgId = organization?.id
  const { data: hasInvitePermission, isPending: permissionPending } =
    useHasPermission({
      organizationId: orgId ?? "",
      permissions: { invitation: ["create"] },
    })

  const { refetch: refetchInvitations } = useListInvitations({
    query: { organizationId: orgId ?? "" },
  })

  const { data: sessionData } = useSession()

  const { data: membersData } = useListMembers({
    query: { organizationId: orgId ?? "" },
  })

  const members = membersData?.members
  const membership = members?.find((m) => m.userId === sessionData?.user.id)

  const builtInRoles = [
    { role: "owner", label: localization.OWNER },
    { role: "admin", label: localization.ADMIN },
    { role: "member", label: localization.MEMBER },
  ] as const

  const roles = [...builtInRoles, ...(organizationOptions?.customRoles || [])]
  const availableRoles = roles.filter(
    (role) => membership?.role === "owner" || role.role !== "owner",
  )

  const { data: teamsRaw } = useListTeams({
    organizationId: organization?.id ?? "",
  })
  const teams = teamsEnabled ? teamsRaw : undefined

  const [modalOpen, setModalOpen] = useState(false)
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<string>("member")
  const [teamId, setTeamId] = useState("")
  const [busy, setBusy] = useState(false)

  const inviteAndResolvePayload = useCallback(
    async (
      organizationRecord: Organization,
      inviteEmail: string,
      inviteRole: string,
      inviteTeamId: string | undefined,
      resend: boolean,
    ): Promise<InvitationPayload> => {
      const result = await authClient.organization.inviteMember({
        email: inviteEmail,
        role: inviteRole,
        organizationId: organizationRecord.id,
        fetchOptions: { throw: false },
        ...(resend ? { resend: true } : {}),
        ...(teamsEnabled && inviteTeamId ? { teamId: inviteTeamId } : {}),
      })

      const payload = result.data as InvitationPayload | undefined
      if (payload?.id && payload.email) return payload

      const err = result.error ?? new Error("Invitation failed")
      if (!resend && isAlreadyInvitedError(err)) {
        return inviteAndResolvePayload(
          organizationRecord,
          inviteEmail,
          inviteRole,
          inviteTeamId,
          true,
        )
      }
      throw err
    },
    [authClient.organization, teamsEnabled],
  )

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!organization || busy) return
    const trimmed = email.trim().toLowerCase()
    if (!trimmed.includes("@")) {
      toast({
        variant: "error",
        message: localization.INVALID_EMAIL ?? "Enter a valid email address.",
      })
      return
    }

    setBusy(true)
    try {
      const invitation = await inviteAndResolvePayload(
        organization,
        trimmed,
        role,
        teamId || undefined,
        false,
      )

      const link = buildOrganizationInviteLink({
        origin: window.location.origin,
        invitationId: invitation.id,
        email: invitation.email.toLowerCase(),
      })

      await navigator.clipboard.writeText(link)

      toast({
        variant: "success",
        message:
          "Invitation link copied. Share it with your teammate — they must sign up or sign in with this email.",
      })
      await refetchInvitations?.()
      setModalOpen(false)
      setEmail("")
      setRole("member")
      setTeamId("")
    } catch (error) {
      toast({
        variant: "error",
        message: extractErrorMessage(error),
      })
    } finally {
      setBusy(false)
    }
  }

  const showRow =
    organization && !permissionPending && hasInvitePermission?.success === true

  if (!showRow) return null

  return (
    <>
      <div
        className={cn(
          "ctx-border ctx-surface flex flex-col gap-3 border border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
          classNames?.base,
        )}
      >
        <p
          className={cn(
            "text-center text-muted-foreground text-xs sm:text-start sm:text-sm",
            classNames?.instructions,
          )}
        >
          No SMTP or email not arriving? Create an invitation and{" "}
          <strong className="font-medium text-foreground">
            copy a shareable link
          </strong>{" "}
          instead.
        </p>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "shrink-0 border-white/75 sm:ms-auto",
            classNames?.outlineButton,
          )}
          onPress={() => setModalOpen(true)}
        >
          Copy invite link
        </Button>
      </div>

      {modalOpen ? (
        <Modal isOpen={modalOpen} onOpenChange={setModalOpen} isDismissable>
          <DialogContent
            showCloseButton
            className="max-w-md border-zinc-800 bg-zinc-950/95"
          >
            <DialogHeader>
              <DialogTitle>Copy invite link</DialogTitle>
              <DialogDescription>
                We create a pending invitation (same as &quot;Invite
                member&quot;) and copy the accept URL. The invitee must use the
                email address you enter here when they sign up or sign in.
              </DialogDescription>
            </DialogHeader>

            <form
              onSubmit={(ev) => void onSubmit(ev)}
              className="mt-4 space-y-4"
            >
              <div className="space-y-1.5">
                <label
                  htmlFor="copy-invite-email"
                  className={cn("text-sm text-zinc-300", classNames?.label)}
                >
                  {localization.EMAIL}
                </label>
                <Input
                  id="copy-invite-email"
                  type="email"
                  autoComplete="email"
                  placeholder={localization.EMAIL_PLACEHOLDER}
                  value={email}
                  onChange={(ev) => setEmail(ev.target.value)}
                  className={cn("rounded-none", classNames?.input)}
                  required
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    htmlFor="copy-invite-role"
                    className={cn("text-sm text-zinc-300", classNames?.label)}
                  >
                    {localization.ROLE}
                  </label>
                  <select
                    id="copy-invite-role"
                    value={role}
                    onChange={(ev) => setRole(ev.target.value)}
                    className={cn(
                      "h-9 w-full rounded-none border border-border bg-transparent px-2.5 py-1 text-sm text-zinc-100",
                      classNames?.input,
                    )}
                  >
                    {availableRoles.map((r) => (
                      <option key={r.role} value={r.role}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>

                {teamsEnabled && teams && teams.length > 0 ? (
                  <div className="space-y-1.5">
                    <label
                      htmlFor="copy-invite-team"
                      className={cn("text-sm text-zinc-300", classNames?.label)}
                    >
                      {localization.TEAM}
                    </label>
                    <select
                      id="copy-invite-team"
                      value={teamId}
                      onChange={(ev) => setTeamId(ev.target.value)}
                      className={cn(
                        "h-9 w-full rounded-none border border-border bg-transparent px-2.5 py-1 text-sm text-zinc-100",
                        classNames?.input,
                      )}
                    >
                      <option value="">{localization.SELECT_TEAMS}</option>
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  onPress={() => setModalOpen(false)}
                >
                  {localization.CANCEL}
                </Button>
                <Button type="submit" variant="primary" isDisabled={busy}>
                  {busy ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />{" "}
                      Working…
                    </>
                  ) : (
                    "Copy link"
                  )}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Modal>
      ) : null}
    </>
  )
}
