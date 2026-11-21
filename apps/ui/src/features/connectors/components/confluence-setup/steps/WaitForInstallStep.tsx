import { InlineLoader } from "@/components/ui/InlineLoader"

/**
 * The Confluence setup step that waits until Atlassian confirms the Forge app
 * install. The wizard goes to the next step when the confirmation comes.
 */
export function WaitForInstallStep() {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-foreground">
          Waiting for installation
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Atlassian must confirm the install of the Forge app. This can take a
          few minutes, also after the Atlassian page says that the install is
          done. The next step opens when Atlassian confirms it.
        </p>
      </div>
      <InlineLoader label="Waiting for Atlassian" />
    </div>
  )
}
