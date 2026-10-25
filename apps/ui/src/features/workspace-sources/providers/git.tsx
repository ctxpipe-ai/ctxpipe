import { IconGitBranch } from "@tabler/icons-react"

import type {
  SourceProviderUi,
  SourceScopeEditorProps,
} from "../source-provider-ui"

/**
 * A plain git source has no connection, so the settings pane has no editor
 * for it (CTX-815). A person adds or changes its file under `sources/git/`
 * with a pull request.
 */
function GitScopeEditor(_props: SourceScopeEditorProps) {
  return (
    <p className="text-sm text-muted-foreground">
      Change a plain git source with a pull request to its file under{" "}
      <code className="font-mono">sources/git/</code>.
    </p>
  )
}

/** Plain git source UI: an icon, and no editor. */
export const gitSourceUi: SourceProviderUi = {
  Icon: IconGitBranch,
  ScopeEditor: GitScopeEditor,
}
