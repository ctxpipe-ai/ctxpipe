import { Button } from "@/components/ui/Button"

export type AtlassianAccountClaimModalContentProps = {
  onCancel: () => void | Promise<void>
  onConfirm: () => void | Promise<void>
}

/** Pending Atlassian account claim (search `pendingAccountClaim`). Used inside the Connectors `Modal`. */
export function AtlassianAccountClaimModalContent({
  onCancel,
  onConfirm,
}: AtlassianAccountClaimModalContentProps) {
  return (
    <div className="px-6 py-5">
      <h2 className="text-base font-semibold text-zinc-100">
        Connect this Atlassian account?
      </h2>
      <p className="mt-2 text-sm text-zinc-300">
        This Atlassian account is already linked to another user here.
      </p>
      <p className="mt-2 text-sm text-zinc-300">
        If you continue, your current profile will be linked to this Atlassian
        account, and the other user’s Atlassian connection will be unlinked.
      </p>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onPress={onCancel}>
          No, cancel
        </Button>
        <Button variant="primary" onPress={onConfirm}>
          Yes, use this profile
        </Button>
      </div>
    </div>
  )
}
