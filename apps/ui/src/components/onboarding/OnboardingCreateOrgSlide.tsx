"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { useId, useState } from "react"
import { authClient } from "@/lib/auth-client"

const ORG_SLUG_MAX_LENGTH = 32

type OnboardingCreateOrgSlideProps = {
  onOrgCreated: (newOrgSlug: string) => void
}

export function OnboardingCreateOrgSlide({
  onOrgCreated,
}: OnboardingCreateOrgSlideProps) {
  const orgNameFieldId = useId()
  const orgSlugFieldId = useId()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [orgName, setOrgName] = useState("")
  const [orgSlug, setOrgSlug] = useState("")
  const [validationError, setValidationError] = useState<string | null>(null)

  const createOrg = useMutation({
    mutationFn: async (input: { name: string; slug: string }) => {
      const result = await authClient.organization.create(input)
      if (result.error) {
        throw new Error(result.error.message ?? "Failed to create organisation")
      }
      if (!result.data?.slug) {
        throw new Error("Failed to create organisation")
      }
      return result.data
    },
    onSuccess: async (org) => {
      await queryClient.invalidateQueries({
        queryKey: ["organizations"],
        refetchType: "active",
      })
      void router.navigate({
        to: "/onboarding",
        search: (prev) => ({ ...prev, orgSlug: org.slug }),
        replace: true,
      })
      onOrgCreated(org.slug)
    },
  })

  const slugTrimmedPreview = orgSlug.trim()
  const slugTooLong = slugTrimmedPreview.length > ORG_SLUG_MAX_LENGTH
  const orgError =
    validationError ??
    (createOrg.error instanceof Error ? createOrg.error.message : null)

  const handleCreateOrg = () => {
    const trimmed = orgName.trim()
    if (!trimmed) {
      setValidationError("Enter a name for your organisation.")
      return
    }
    const slug = orgSlug.trim()
    if (!slug) {
      setValidationError(
        "Enter the organisation slug. It must be the same orgSlug you set in your AWS CDK stack.",
      )
      return
    }
    if (slug.length > ORG_SLUG_MAX_LENGTH) {
      setValidationError(
        `Organisation slug must be at most ${ORG_SLUG_MAX_LENGTH} characters.`,
      )
      return
    }
    setValidationError(null)
    createOrg.mutate({ name: trimmed, slug })
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
            disabled={createOrg.isPending}
            onChange={(e) => {
              setOrgName(e.target.value)
              setValidationError(null)
              createOrg.reset()
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateOrg()
            }}
            placeholder="Acme Engineering"
            className="mb-4 h-11 w-full rounded-none border border-border bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-teal-400/60"
            // biome-ignore lint/a11y/noAutofocus: first field on this step of onboarding
            autoFocus
          />
          <label
            className="mb-2 block text-sm text-zinc-200"
            htmlFor={orgSlugFieldId}
          >
            Slug URL
          </label>
          <p className="mb-2 text-xs leading-relaxed text-zinc-400">
            If you are self-hosting on AWS, use the same organisation slug as
            the{" "}
            <code className="rounded-none bg-zinc-900 px-1 py-0.5 font-mono text-[11px] text-zinc-300">
              orgSlug
            </code>{" "}
            you passed to{" "}
            <code className="rounded-none bg-zinc-900 px-1 py-0.5 font-mono text-[11px] text-zinc-300">
              @ctxpipe/aws-cdk
            </code>
          </p>
          <input
            id={orgSlugFieldId}
            type="text"
            value={orgSlug}
            disabled={createOrg.isPending}
            aria-invalid={slugTooLong}
            onChange={(e) => {
              setOrgSlug(e.target.value)
              setValidationError(null)
              createOrg.reset()
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateOrg()
            }}
            placeholder="acme-engineering"
            className="mb-4 h-11 w-full rounded-none border border-border bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-teal-400/60"
          />
          {orgError ? (
            <p className="mb-4 text-xs text-red-400">{orgError}</p>
          ) : null}
          <div className="flex justify-end">
            <button
              type="button"
              disabled={createOrg.isPending}
              className="inline-flex h-10 items-center justify-center rounded-none border border-border bg-zinc-100 px-5 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:opacity-50"
              onClick={handleCreateOrg}
            >
              Create organisation
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
