"use client"

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

const ORG_SLUG_MAX_LENGTH = 32
const ORG_SLUG_PATTERN = /^[a-z0-9-]+$/

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
        throw new Error("Failed to create organisation")
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
      resetForm()
      onOpenChange(false)
      await router.navigate({
        to: "/$orgSlug/setup",
        params: { orgSlug: organization.slug },
        replace: true,
      })
    },
    onError: (error) => {
      setValidationError(
        error instanceof Error
          ? error.message
          : "Failed to create organisation",
      )
    },
  })

  const slugTrimmedPreview = orgSlug.trim()
  const slugTooLong = slugTrimmedPreview.length > ORG_SLUG_MAX_LENGTH
  const orgError =
    validationError ??
    (createOrg.error instanceof Error ? createOrg.error.message : null)

  const handleOpenChange = (open: boolean) => {
    if (!open) resetForm()
    onOpenChange(open)
  }

  const handleCreate = () => {
    const trimmed = orgName.trim()
    if (!trimmed) {
      setValidationError("Enter a name for your organisation.")
      return
    }
    const slug = orgSlug.trim()
    if (!slug) {
      setValidationError("Enter an organisation slug.")
      return
    }
    if (slug.length > ORG_SLUG_MAX_LENGTH) {
      setValidationError(
        `Organisation slug must be at most ${ORG_SLUG_MAX_LENGTH} characters.`,
      )
      return
    }
    if (!ORG_SLUG_PATTERN.test(slug)) {
      setValidationError(
        "Organisation slug may only contain lowercase letters, numbers, and hyphens.",
      )
      return
    }
    setValidationError(null)
    createOrg.mutate({ name: trimmed, slug })
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={handleOpenChange} isDismissable>
      <Dialog>
        {({ close }) => (
          <div className="rounded-none bg-zinc-950/95 p-6">
            <DialogHeader className="mb-4">
              <DialogTitle className="text-lg text-zinc-100">
                Create organisation
              </DialogTitle>
              <DialogDescription>
                Set up a new organisation workspace for your team.
              </DialogDescription>
            </DialogHeader>
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
                if (e.key === "Enter") handleCreate()
              }}
              placeholder="Acme Engineering"
              className="mb-4 h-11 w-full rounded-none border border-border bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-teal-400/60 disabled:opacity-50"
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
              aria-invalid={slugTooLong}
              onChange={(e) => {
                setOrgSlug(e.target.value)
                setValidationError(null)
                createOrg.reset()
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate()
              }}
              placeholder="acme-engineering"
              className="mb-4 h-11 w-full rounded-none border border-border bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-teal-400/60 disabled:opacity-50"
            />
            {orgError ? (
              <p className="mb-4 text-xs text-red-400">{orgError}</p>
            ) : null}
            <div className="flex justify-end gap-3">
              <Button
                variant="ghost"
                className="rounded-none text-zinc-400 hover:text-zinc-200"
                isDisabled={createOrg.isPending}
                onPress={() => close()}
              >
                Cancel
              </Button>
              <Button
                className="rounded-none bg-zinc-100 text-zinc-950 hover:bg-zinc-200"
                isDisabled={createOrg.isPending}
                onPress={() => handleCreate()}
              >
                Create organisation
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Modal>
  )
}
