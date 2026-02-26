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
  const [touched, setTouched] = useState({ name: false, gitUrl: false })

  const nameError = touched.name && !name.trim() ? "Repository name is required" : undefined
  const gitUrlError = touched.gitUrl && !gitUrl.trim() ? "Git URL is required" : undefined
  const isValid = name.trim() && gitUrl.trim()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched({ name: true, gitUrl: true })
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
        onChange={(value) => {
          setName(value)
          setTouched((prev) => ({ ...prev, name: true }))
        }}
        placeholder="my-repo"
        description="Display name for the repository"
        isRequired
        errorMessage={nameError}
        isInvalid={!!nameError}
      />
      <TextField
        label="Git URL"
        name="gitUrl"
        value={gitUrl}
        onChange={(value) => {
          setGitUrl(value)
          setTouched((prev) => ({ ...prev, gitUrl: true }))
        }}
        placeholder="https://github.com/org/repo.git"
        description="Clone URL (HTTPS or SSH)"
        type="url"
        isRequired
        errorMessage={gitUrlError}
        isInvalid={!!gitUrlError}
      />
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onPress={onClose} type="button">
          Cancel
        </Button>
        <Button variant="primary" type="submit" isDisabled={isPending || !isValid}>
          {isPending ? "Adding…" : "Add repository"}
        </Button>
      </div>
    </form>
  )
}
