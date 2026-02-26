import { Button } from "@/components/ui/Button"
import { Form } from "@/components/ui/Form"
import { TextField } from "@/components/ui/TextField"
import { useState } from "react"

function extractRepoName(gitUrl: string): string | null {
  if (!gitUrl.trim()) return null

  // HTTPS: https://github.com/user/repo.git or https://github.com/user/repo
  const httpsMatch = gitUrl.match(/https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/)
  if (httpsMatch) return httpsMatch[1]

  // SSH: git@github.com:user/repo.git or git@github.com:user/repo
  const sshMatch = gitUrl.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/)
  if (sshMatch) return sshMatch[1]

  return null
}

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
  const [gitUrl, setGitUrl] = useState("")
  const [touched, setTouched] = useState(false)

  const inferredName = extractRepoName(gitUrl)

  const gitUrlError = touched && !gitUrl.trim() ? "Git URL is required" : undefined
  const nameError = touched && gitUrl.trim() && !inferredName ? "Could not infer repository name from URL" : undefined
  const isValid = gitUrl.trim() && !!inferredName

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    const g = gitUrl.trim()
    const n = inferredName
    if (g && n) onSubmit(n, g)
  }

  return (
    <Form
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
        label="Git URL"
        value={gitUrl}
        onChange={(value) => {
          setGitUrl(value)
          setTouched(true)
        }}
        placeholder="https://github.com/org/repo.git"
        description="Clone URL (HTTPS or SSH). Repository name will be inferred from the URL."
        type="url"
        isRequired
        errorMessage={gitUrlError || nameError}
        isInvalid={!!gitUrlError || !!nameError}
      />
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onPress={onClose} type="button">
          Cancel
        </Button>
        <Button variant="primary" type="submit" isDisabled={isPending || !isValid}>
          {isPending ? "Adding…" : "Add repository"}
        </Button>
      </div>
    </Form>
  )
}
