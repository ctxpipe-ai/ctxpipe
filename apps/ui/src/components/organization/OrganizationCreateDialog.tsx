"use client"

import { IconPlus } from "@tabler/icons-react"
import { useId, useState } from "react"
import { Button } from "@/components/ui/Button"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"
import { useCreateOrganization } from "@/lib/useCreateOrganization"

const ORG_SLUG_MAX_LENGTH = 32
const ORG_SLUG_PATTERN = /^[a-z0-9-]+$/

type OrganizationCreateDialogProps = {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (org: { id: string; slug: string; name: string }) => void
}

export function OrganizationCreateDialog({
  isOpen,
  onOpenChange,
  onCreated,
}: OrganizationCreateDialogProps) {
  const orgNameFieldId = useId()
  const orgSlugFieldId = useId()
  const createOrganization = useCreateOrganization()
  const [orgName, setOrgName] = useState("")
  const [orgSlug, setOrgSlug] = useState("")
  const [orgError, setOrgError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const slugTrimmedPreview = orgSlug.trim()
  const slugTooLong = slugTrimmedPreview.length > ORG_SLUG_MAX_LENGTH

  const resetForm = () => {
    setOrgName("")
    setOrgSlug("")
    setOrgError(null)
    setSubmitting(false)
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) resetForm()
    onOpenChange(open)
  }

  const handleCreate = async () => {
    const trimmed = orgName.trim()
    if (!trimmed) {
      setOrgError("Enter a name for your organisation.")
      return
    }
    const slug = orgSlug.trim()
    if (!slug) {
      setOrgError("Enter an organisation slug.")
      return
    }
    if (slug.length > ORG_SLUG_MAX_LENGTH) {
      setOrgError(
        `Organisation slug must be at most ${ORG_SLUG_MAX_LENGTH} characters.`,
      )
      return
    }
    if (!ORG_SLUG_PATTERN.test(slug)) {
      setOrgError(
        "Organisation slug may only contain lowercase letters, numbers, and hyphens.",
      )
      return
    }
    setOrgError(null)
    setSubmitting(true)
    try {
      const org = await createOrganization({ name: trimmed, slug })
      handleOpenChange(false)
      onCreated(org)
    } catch (err) {
      setOrgError(
        err instanceof Error ? err.message : "Failed to create organisation",
      )
      setSubmitting(false)
    }
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
              disabled={submitting}
              onChange={(e) => {
                setOrgName(e.target.value)
                setOrgError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate()
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
              disabled={submitting}
              aria-invalid={slugTooLong}
              onChange={(e) => {
                setOrgSlug(e.target.value)
                setOrgError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate()
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
                isDisabled={submitting}
                onPress={() => close()}
              >
                Cancel
              </Button>
              <Button
                className="rounded-none bg-zinc-100 text-zinc-950 hover:bg-zinc-200"
                isDisabled={submitting}
                onPress={() => void handleCreate()}
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

type OrganizationCreateTriggerProps = {
  expanded: boolean
  onPress: () => void
}

export function OrganizationCreateTrigger({
  expanded,
  onPress,
}: OrganizationCreateTriggerProps) {
  if (expanded) {
    return (
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-400 transition-colors hover:bg-teal-900/30 hover:text-zinc-100"
        onClick={onPress}
      >
        <IconPlus className="h-4 w-4 shrink-0" aria-hidden="true" />
        Create organisation
      </button>
    )
  }

  return (
    <button
      type="button"
      className="mx-auto flex h-8 w-8 items-center justify-center text-zinc-400 transition-colors hover:bg-teal-900/30 hover:text-zinc-100"
      aria-label="Create organisation"
      onClick={onPress}
    >
      <IconPlus className="h-4 w-4" aria-hidden="true" />
    </button>
  )
}
