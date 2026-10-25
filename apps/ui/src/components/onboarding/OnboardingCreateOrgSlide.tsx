"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { authClient } from "@/lib/auth-client"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { useUserPreferences } from "@/lib/user-preferences"
import { orgNameFromEmail, orgSlugError, orgSlugFromName } from "./org-name"

type OnboardingCreateOrgSlideProps = {
  /**
   * Completes onboarding for the new organization. The slide calls it after
   * the organization exists. If onboarding does not complete, "Continue"
   * calls it again.
   */
  onFinish: (newOrgSlug: string) => void
  /** A work email domain gives the first organization name. */
  userEmail?: string | null
  /** True while onboarding completes for the new organization. */
  finishing?: boolean
}

export function OnboardingCreateOrgSlide({
  onFinish,
  userEmail,
  finishing,
}: OnboardingCreateOrgSlideProps) {
  const orgNameFieldId = useId()
  const orgSlugFieldId = useId()
  const queryClient = useQueryClient()
  const [, setPreferences] = useUserPreferences()
  // `null` means the user has not edited the field. Until then the name comes
  // from the email domain and the slug follows the name.
  const [typedOrgName, setOrgName] = useState<string | null>(null)
  const [typedOrgSlug, setOrgSlug] = useState<string | null>(null)
  const orgName = typedOrgName ?? orgNameFromEmail(userEmail)
  const orgSlug = typedOrgSlug ?? orgSlugFromName(orgName)
  const [validationError, setValidationError] = useState<string | null>(null)

  const createOrg = useMutation({
    mutationFn: async (input: { name: string; slug: string }) => {
      const result = await authClient.organization.create(input)
      if (result.error) {
        throw new Error(result.error.message ?? "Failed to create organization")
      }
      if (!result.data?.slug) {
        throw new Error("Failed to create organization")
      }
      return result.data
    },
    // Create also makes the new organization active on the session, and the
    // auth client refreshes its session and active-organization atoms.
    onSuccess: (org) => {
      setPreferences((prev) => ({
        ...prev,
        selectedOrganizationSlug: org.slug,
      }))
      onFinish(org.slug)
      void queryClient.invalidateQueries({
        queryKey: ["organizations"],
        refetchType: "active",
      })
    },
  })

  // The organization exists. Do not send it again: the slug is in use now.
  const createdSlug = createOrg.data?.slug ?? null
  const fieldsLocked = createOrg.isPending || createdSlug !== null
  const slugError = orgSlugError(orgSlug)
  const slugInvalid = orgSlug.trim() !== "" && slugError !== null
  const orgError =
    validationError ??
    (slugInvalid ? slugError : null) ??
    (createOrg.error instanceof Error ? createOrg.error.message : null)

  const handleCreateOrg = () => {
    const trimmed = orgName.trim()
    if (!trimmed) {
      setValidationError("Enter a name for your organization.")
      return
    }
    const slug = orgSlug.trim()
    if (!slug) {
      setValidationError(
        "Enter the organization slug. If you are self-hosting, it must match the slug configured for your deployment.",
      )
      return
    }
    if (slugError) {
      setValidationError(slugError)
      return
    }
    setValidationError(null)
    createOrg.mutate({ name: trimmed, slug })
  }

  return (
    <>
      <h2 className="mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
        Create your organization
      </h2>
      <div className="mx-auto mb-10 max-w-3xl">
        <p className="mx-auto mb-6 text-zinc-300">
          Set up your organization. Your team will join here.
        </p>
        <div className="mx-auto max-w-md rounded-md border border-border bg-zinc-950/70 p-6 text-left">
          <label
            className="mb-2 block text-sm text-zinc-200"
            htmlFor={orgNameFieldId}
          >
            Organization name
          </label>
          <input
            id={orgNameFieldId}
            type="text"
            value={orgName}
            disabled={fieldsLocked}
            onChange={(e) => {
              setOrgName(e.target.value)
              setValidationError(null)
              createOrg.reset()
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !fieldsLocked) handleCreateOrg()
            }}
            placeholder="Acme Engineering"
            className="mb-4 h-11 w-full rounded-md border border-border bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-teal-400/60"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- first field on this step of onboarding
            autoFocus
          />
          <label
            className="mb-2 block text-sm text-zinc-200"
            htmlFor={orgSlugFieldId}
          >
            Slug URL
          </label>
          <p className="mb-2 text-xs leading-relaxed text-zinc-400">
            If you are self-hosting, use the same organization slug you
            configured at deploy time (for example{" "}
            <code className="rounded-md bg-zinc-900 px-1 py-0.5 font-mono text-[11px] text-zinc-300">
              orgSlug
            </code>{" "}
            in your deployment config).
          </p>
          <input
            id={orgSlugFieldId}
            type="text"
            value={orgSlug}
            disabled={fieldsLocked}
            aria-invalid={slugInvalid}
            onChange={(e) => {
              setOrgSlug(e.target.value)
              setValidationError(null)
              createOrg.reset()
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !fieldsLocked) handleCreateOrg()
            }}
            placeholder="acme-engineering"
            className="mb-4 h-11 w-full rounded-md border border-border bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-teal-400/60"
          />
          {orgError ? (
            <p className="mb-4 text-xs text-red-400">{orgError}</p>
          ) : null}
          <div className="flex justify-end">
            {/* A native button: the double-click guard (ignoreRepeatClick) needs click events. */}
            <button
              type="button"
              disabled={createOrg.isPending || finishing || slugInvalid}
              className={`${focusVisibleClassName} inline-flex h-10 items-center justify-center rounded-md border border-border bg-zinc-100 px-5 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:opacity-50`}
              onClick={() =>
                createdSlug ? onFinish(createdSlug) : handleCreateOrg()
              }
            >
              {createdSlug && !finishing ? "Continue" : "Create organization"}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
