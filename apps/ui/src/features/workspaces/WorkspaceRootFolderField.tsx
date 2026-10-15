import { TextField } from "@/components/ui/TextField"
import { rootFolderError } from "./rootFolder"

/** The root folder of a Workspace in its repository, with the hint that explains it. */
export function WorkspaceRootFolderField(props: {
  value: string
  onChange: (value: string) => void
  isDisabled?: boolean
}) {
  const error = rootFolderError(props.value)
  return (
    <TextField
      label="Root folder"
      placeholder="docs/context"
      value={props.value}
      onChange={props.onChange}
      isDisabled={props.isDisabled}
      isInvalid={error !== null}
      errorMessage={error ?? undefined}
      description="The folder in the repository that holds this Workspace. ctxpipe reads and changes files only in this folder. Leave it empty to use the whole repository."
    />
  )
}
