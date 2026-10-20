import { useMutation } from "@tanstack/react-query"
import {
  checkPlainGitUrl,
  plainGitSchemeRule,
  plainGitUrlPolicy,
} from "backend/domain/workspace-sources/providers/git"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"
import {
  createWorkspaceSource,
  type WorkspaceSourceChangeResult,
} from "./queries"

/**
 * The problem of a plain git URL that the UI can see, or null. The UI does
 * not know the deployment mode, so it checks with the rules of each mode
 * (no user name, no query, a simple path), and it names the https rule for
 * a URL with another scheme. The backend then checks the URL with the policy
 * of its mode and the DNS check, and the form shows that answer.
 */
function plainGitUrlProblem(raw: string): string | null {
  const checked = checkPlainGitUrl(raw, plainGitUrlPolicy("self-host"))
  if (checked.ok) return null
  return checked.rule === "not_https" || checked.rule === "not_a_url"
    ? plainGitSchemeRule(plainGitUrlPolicy("hosted"))
    : `${checked.reason}.`
}

/**
 * "Paste URL" in Add repositories: add one plain git repository by its
 * https URL. The add opens a pull request that adds its file under
 * `sources/git/`. A refused URL shows its reason under the field.
 */
export function AddRepositoryByUrlForm(props: {
  orgSlug: string
  workspaceSlug: string
  onAdded: (result: WorkspaceSourceChangeResult) => void
  onCancel: () => void
}) {
  const { orgSlug, workspaceSlug, onAdded, onCancel } = props
  const [url, setUrl] = useState("")
  // Check the URL after the user leaves the field or submits, not while they type.
  const [checked, setChecked] = useState(false)
  const [refused, setRefused] = useState<{ url: string; reason: string }>()
  const value = url.trim()
  const problem = value ? plainGitUrlProblem(value) : null
  const error =
    (checked ? problem : null) ??
    (refused?.url === value ? refused.reason : null)

  const addMutation = useMutation({
    mutationFn: (gitUrl: string) =>
      createWorkspaceSource(orgSlug, workspaceSlug, {
        provider: "git",
        connectionId: null,
        scope: { url: gitUrl },
      }),
    onSuccess: onAdded,
    onError: (failure: Error, gitUrl) =>
      setRefused({ url: gitUrl, reason: failure.message }),
  })

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        setChecked(true)
        if (value && !problem) addMutation.mutate(value)
      }}
    >
      <TextField
        label="Repository URL"
        value={url}
        onChange={setUrl}
        onBlur={() => setChecked(Boolean(value))}
        placeholder="https://github.com/owner/name"
        isInvalid={error !== null}
        errorMessage={error ?? undefined}
        isDisabled={addMutation.isPending}
        description="Use a public repository. ctxpipe reads it over HTTPS with no credential."
        autoComplete="off"
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button
          variant="quiet"
          isDisabled={addMutation.isPending}
          onPress={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          isDisabled={!value || (checked && problem !== null)}
          isPending={addMutation.isPending}
        >
          Open a pull request
        </Button>
      </div>
    </form>
  )
}
