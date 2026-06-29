import { useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { authClient } from "@/lib/auth-client"
import { invalidateOrganizationList } from "@/lib/organization-queries"

export type CreatedOrganization = {
  id: string
  slug: string
  name: string
}

export function useCreateOrganization() {
  const queryClient = useQueryClient()

  return useCallback(
    async (input: {
      name: string
      slug: string
    }): Promise<CreatedOrganization> => {
      const result = await authClient.organization.create({
        name: input.name,
        slug: input.slug,
      })
      if (result.error) {
        throw new Error(result.error.message ?? "Failed to create organisation")
      }
      const org = result.data
      if (!org?.slug) {
        throw new Error("Failed to create organisation")
      }
      await invalidateOrganizationList(queryClient)
      return { id: org.id, slug: org.slug, name: org.name }
    },
    [queryClient],
  )
}
