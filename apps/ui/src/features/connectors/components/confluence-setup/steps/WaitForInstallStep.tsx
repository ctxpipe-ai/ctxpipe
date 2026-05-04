import { Spinner } from "@/components/ui/spinner"

export function WaitForInstallStep() {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-zinc-100">
          Waiting for installation
        </h3>
        <p className="mt-2 text-sm text-zinc-400">
          Hang tight—we are waiting for Atlassian to confirm the install, which
          can take a few minutes even after their UI says that installation was
          done.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Spinner className="text-zinc-400" />
        <span className="text-sm text-zinc-300">
          Waiting for confirmation from Atlassian...
        </span>
      </div>
    </div>
  )
}
