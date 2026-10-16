"use client"

import HyperDX from "@hyperdx/browser"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { useId, useState } from "react"
import { Button } from "@/components/ui/Button"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"
import { authClient } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"
import { cn } from "@/lib/utils"
import { completeOnboarding } from "../onboarding/complete-onboarding"
import { orgSlugError } from "../onboarding/org-name"

type SideNavOrganizationCreateDialogProps = {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

export function SideNavOrganizationCreateDialog({
  isOpen,
  onOpenChange,
}: SideNavOrganizationCreateDialogProps) {
  const orgNameFieldId = useId()
  const orgSlugFieldId = useId()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [, setPreferences] = useUserPreferences()
  const [orgName, setOrgName] = useState("")
  const [orgSlug, setOrgSlug] = useState("")
  const [validationError, setValidationError] = useState<string | null>(null)

  const resetForm = () => {
    setOrgName("")
    setOrgSlug("")
    setValidationError(null)
  }

  const createOrg = useMutation({
    mutationFn: async (input: { name: string; slug: string }) => {
      const organization = await authClient.organization.create({
        ...input,
        fetchOptions: { throw: true },
      })
      if (
        !organization ||
        typeof organization !== "object" ||
        !("slug" in organization) ||
        typeof organization.slug !== "string"
      ) {
        throw new Error("Failed to create organization")
      }
      return organization as { id: string; slug: string; name: string }
    },
    onSuccess: async (organization) => {
      await authClient.organization.setActive({
        organizationId: organization.id,
        fetchOptions: { throw: true },
      })
      await queryClient.invalidateQueries({
        queryKey: ["organizations"],
        refetchType: "active",
      })
      setPreferences((prev) => ({
        ...prev,
        selectedOrganizationSlug: organization.slug,
      }))
      // Home shows the Get started guide for the new organization. The user
      // completed onboarding before, so a failure here only hides the guide.
      await completeOnboarding(organization.slug, queryClient).catch((error) =>
        HyperDX.recordException(error),
      )
      resetForm()
      onOpenChange(false)
      await router.navigate({
        to: "/$orgSlug",
        params: { orgSlug: organization.slug },
        replace: true,
      })
    },
    onError: (error) => {
      setValidationError(
        error instanceof Error
          ? error.message
          : "Failed to create organization",
      )
    },
  })

  const slugError = orgSlugError(orgSlug)
  const slugInvalid = orgSlug.trim() !== "" && slugError !== null
  const orgError =
    validationError ??
    (slugInvalid ? slugError : null) ??
    (createOrg.error instanceof Error ? createOrg.error.message : null)

  const handleOpenChange = (open: boolean) => {
    if (createOrg.isPending) return
    if (!open) resetForm()
    onOpenChange(open)
  }

  const handleCreate = () => {
    const trimmed = orgName.trim()
    if (!trimmed) {
      setValidationError("Enter a name for your organization.")
      return
    }
    const slug = orgSlug.trim()
    if (slugError) {
      setValidationError(slugError)
      return
    }
    setValidationError(null)
    createOrg.mutate({ name: trimmed, slug })
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={handleOpenChange}
      isDismissable={!createOrg.isPending}
    >
      <Dialog>
        {({ close }) => (
          <>
            <DialogHeader>
              <DialogTitle>Create organization</DialogTitle>
              <DialogDescription>
                Set up a new organization workspace for your team.
              </DialogDescription>
            </DialogHeader>
            <label
              className="mb-2 mt-4 block text-sm text-zinc-200"
              htmlFor={orgNameFieldId}
            >
              Organization name
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
                if (e.key === "Enter" && !createOrg.isPending) handleCreate()
              }}
              placeholder="Acme Engineering"
              className="mb-4 h-11 w-full rounded-md border border-border bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-teal-400/60 disabled:opacity-50"
            />
            <label
              className="mb-2 block text-sm text-zinc-200"
              htmlFor={orgSlugFieldId}
            >
              Slug URL
            </label>
            <input
              id={orgSlugFieldId}
              type="text"
              value={orgSlug}
              disabled={createOrg.isPending}
              aria-invalid={slugInvalid}
              onChange={(e) => {
                setOrgSlug(e.target.value)
                setValidationError(null)
                createOrg.reset()
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !createOrg.isPending) handleCreate()
              }}
              placeholder="acme-engineering"
              className="mb-4 h-11 w-full rounded-md border border-border bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-teal-400/60 disabled:opacity-50"
            />
            {orgError ? (
              <p className="mb-4 text-xs text-red-400">{orgError}</p>
            ) : null}
            <div className="flex justify-end gap-3">
              <Button
                variant="ghost"
                className="rounded-md text-zinc-400 hover:text-zinc-200"
                isDisabled={createOrg.isPending}
                onPress={() => close()}
              >
                Cancel
              </Button>
              <Button
                className={cn(
                  "min-w-[11rem] rounded-md bg-zinc-100 hover:bg-zinc-200",
                  createOrg.isPending
                    ? "!text-transparent [&_svg]:text-zinc-950"
                    : "text-zinc-950",
                )}
                isDisabled={createOrg.isPending || slugInvalid}
                isPending={createOrg.isPending}
                onPress={() => handleCreate()}
              >
                Create organization
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </Modal>
  )
}
