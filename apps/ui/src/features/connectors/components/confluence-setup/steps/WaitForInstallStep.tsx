import { InlineLoader } from "@/components/ui/InlineLoader"

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
