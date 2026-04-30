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
    <div className="p-6">
      <h2 className="text-base font-medium text-foreground">
        Connect this Atlassian account?
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        This Atlassian account is already linked to another user here.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        If you continue, your current profile will be linked to this Atlassian
        account, and the other user’s Atlassian connection will be unlinked.
      </p>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" className="rounded-none" onPress={onCancel}>
          No, cancel
        </Button>
        <Button variant="primary" className="rounded-none" onPress={onConfirm}>
          Yes, use this profile
        </Button>
      </div>
    </div>
  )
}
