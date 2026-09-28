import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"
import { authClient } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"
import { slugify } from "./onboarding-state"

type OnboardingOrgStepProps = {
  slug: string
  onSlugChange: (slug: string) => void
  onCreated: (slug: string) => void
}

/**
 * The slug is lifted so the picture's frame label follows it as they type.
 * It tracks the name until they edit the slug field themselves.
 */
export function OnboardingOrgStep({
  slug,
  onSlugChange,
  onCreated,
}: OnboardingOrgStepProps) {
  const queryClient = useQueryClient()
  const [, setPreferences] = useUserPreferences()
  const [name, setName] = useState("")
  const [slugTouched, setSlugTouched] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  const createOrg = useMutation({
    mutationFn: async (input: { name: string; slug: string }) => {
      const result = await authClient.organization.create(input)
      if (result.error) {
        throw new Error(result.error.message ?? "Failed to create organisation")
      }
      if (!result.data?.slug) throw new Error("Failed to create organisation")
      return result.data
    },
    onSuccess: async (org) => {
      await authClient.organization.setActive({
        organizationId: org.id,
        fetchOptions: { throw: true },
      })
      setPreferences((prev) => ({
        ...prev,
        selectedOrganizationSlug: org.slug,
      }))
      onCreated(org.slug)
      void queryClient.invalidateQueries({
        queryKey: ["organizations"],
        refetchType: "active",
      })
    },
  })

  const error =
    validationError ??
    (createOrg.error instanceof Error ? createOrg.error.message : null)

  const submit = () => {
    const trimmedName = name.trim()
    const trimmedSlug = slug.trim()
    if (!trimmedName) {
      setValidationError("Enter a name for your organisation.")
      return
    }
    if (!trimmedSlug) {
      setValidationError(
        "Enter a slug. If you self-host, use the slug from your deployment config.",
      )
      return
    }
    if (trimmedSlug.length > 32) {
      setValidationError("Slugs are 32 characters or fewer.")
      return
    }
    setValidationError(null)
    createOrg.mutate({ name: trimmedName, slug: trimmedSlug })
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <TextField
        label="Organisation name"
        placeholder="Acme Engineering"
        value={name}
        isDisabled={createOrg.isPending}
        autoFocus
        onChange={(value) => {
          setName(value)
          setValidationError(null)
          createOrg.reset()
          if (!slugTouched) onSlugChange(slugify(value))
        }}
      />
      <TextField
        label="Slug"
        placeholder="acme-engineering"
        description="Self-hosting? Use the slug from your deployment config."
        value={slug}
        isDisabled={createOrg.isPending}
        className="[&_input]:font-mono"
        onChange={(value) => {
          setSlugTouched(true)
          onSlugChange(value)
          setValidationError(null)
          createOrg.reset()
        }}
      />
      {error ? (
        <p role="alert" className="m-0 text-sm text-red-300">
          {error}
        </p>
      ) : null}
      <div>
        <Button
          type="submit"
          variant="primary"
          className="rounded-none"
          isPending={createOrg.isPending}
        >
          Create organisation
        </Button>
      </div>
    </form>
  )
}
