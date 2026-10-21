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
      placeholder="Leave empty to use the whole repository"
      value={props.value}
      onChange={props.onChange}
      isDisabled={props.isDisabled}
      isInvalid={error !== null}
      errorMessage={error ?? undefined}
      description="A team can keep its context in a folder of an existing repository. You can also keep several Workspaces in one repository, with one folder for each. ctxpipe reads and changes files only in this folder."
    />
  )
}
