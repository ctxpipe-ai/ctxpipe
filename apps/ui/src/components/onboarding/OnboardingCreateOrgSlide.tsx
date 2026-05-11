"use client"

import { useRouter } from "@tanstack/react-router"
import { useId, useState } from "react"
import { randomSuffix, slugify } from "@/components/onboarding/org-slug"
import { authClient } from "@/lib/auth-client"

type OnboardingCreateOrgSlideProps = {
  onOrgCreated: (newOrgSlug: string) => void
}

export function OnboardingCreateOrgSlide({
  onOrgCreated,
}: OnboardingCreateOrgSlideProps) {
  const orgNameFieldId = useId()
  const router = useRouter()
  const [orgName, setOrgName] = useState("")
  const [orgError, setOrgError] = useState<string | null>(null)

  const handleCreateOrg = async () => {
    const trimmed = orgName.trim()
    if (!trimmed) {
      setOrgError("Enter a name for your organisation.")
      return
    }
    setOrgError(null)
    const base = slugify(trimmed)
    const slug = base ? `${base}-${randomSuffix()}` : randomSuffix()
    try {
      const result = await authClient.organization.create({
        name: trimmed,
        slug,
      })
      if (result.error)
        throw new Error(result.error.message ?? "Failed to create organisation")
      if (result.data?.slug) {
        void router.navigate({
          to: "/onboarding",
          search: (prev) => ({ ...prev, orgSlug: result.data.slug }),
          replace: true,
        })
        onOrgCreated(result.data.slug)
      }
    } catch (err) {
      setOrgError(
        err instanceof Error ? err.message : "Failed to create organisation",
      )
    }
  }

  return (
    <>
      <h2 className="onb-in-1 mb-4 text-3xl font-semibold text-zinc-100 sm:text-4xl">
        Create your organisation
      </h2>
      <div className="onb-in-2 mx-auto mb-10 max-w-3xl">
        <p className="mx-auto mb-6 text-zinc-300">
          Set up your organisation to start building your context layer. Your
          team will join here.
        </p>
        <div className="mx-auto max-w-md rounded-none border border-border bg-zinc-950/70 p-6 text-left">
          <label
            className="mb-2 block text-sm text-zinc-200"
            htmlFor={orgNameFieldId}
          >
            Organisation name
          </label>
          <input
            id={orgNameFieldId}
            type="text"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateOrg()
            }}
            placeholder="Acme Engineering"
            className="mb-4 h-11 w-full rounded-none border border-border bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-teal-400/60"
            // biome-ignore lint/a11y/noAutofocus: first field on this step of onboarding
            autoFocus
          />
          {orgError ? (
            <p className="mb-4 text-xs text-red-400">{orgError}</p>
          ) : null}
          <div className="flex justify-end">
            <button
              type="button"
              className="inline-flex h-10 items-center justify-center rounded-none border border-border bg-zinc-100 px-5 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:opacity-50"
              onClick={() => void handleCreateOrg()}
            >
              Create organisation
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
