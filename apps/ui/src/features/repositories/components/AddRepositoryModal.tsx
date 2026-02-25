import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"
import { useState } from "react"

export function AddRepositoryModal({
  onClose,
  onSubmit,
  isPending,
  error,
}: {
  onClose: () => void
  onSubmit: (name: string, gitUrl: string) => void
  isPending: boolean
  error: string | undefined
}) {
  const [name, setName] = useState("")
  const [gitUrl, setGitUrl] = useState("")

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    const g = gitUrl.trim()
    if (n && g) onSubmit(n, g)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-5 p-6 text-neutral-800 dark:text-neutral-200"
    >
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
        Add repository
      </h2>
      {error && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
      <TextField
        label="Name"
        name="name"
        value={name}
        onChange={setName}
        placeholder="my-repo"
        description="Display name for the repository"
        isRequired
      />
      <TextField
        label="Git URL"
        name="gitUrl"
        value={gitUrl}
        onChange={setGitUrl}
        placeholder="https://github.com/org/repo.git"
        description="Clone URL (HTTPS or SSH)"
        type="url"
        isRequired
      />
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onPress={onClose} type="button">
          Cancel
        </Button>
        <Button variant="primary" type="submit" isDisabled={isPending}>
          {isPending ? "Adding…" : "Add repository"}
        </Button>
      </div>
    </form>
  )
}
