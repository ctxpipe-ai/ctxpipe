import {
  SOURCE_SCOPES,
  type SourceProvider,
} from "backend/domain/workspace-sources/sources-file"
import type { ComponentType } from "react"

import { confluenceSourceUi } from "./providers/confluence"
import { gitSourceUi } from "./providers/git"
import { githubSourceUi } from "./providers/github"
import { linearSourceUi } from "./providers/linear"
import { notionSourceUi } from "./providers/notion"
import { pagerdutySourceUi } from "./providers/pagerduty"
import { plainSourceUi } from "./providers/plain"
import { slackSourceUi } from "./providers/slack"

/**
 * The props of a provider scope editor. The editor edits the scope part of
 * one source file (the front matter without `provider` and
 * `connection`).
 */
export type SourceScopeEditorProps = {
  orgSlug: string
  provider: SourceProvider
  connectionId: string
  /** The scope to start from. An add starts from `{}`. */
  initialScope: Record<string, unknown>
  /** Give a valid scope, or `null` while the input is not complete. */
  onChange: (scope: Record<string, unknown> | null) => void
  /** A unique label suffix when one form shows more than one editor. */
  label?: string
}

/**
 * The UI slots of one provider. Each phase 2 provider agent replaces its own
 * module in `./providers/`.
 */
export type SourceProviderUi = {
  Icon: ComponentType<{ className?: string }>
  /** The scope editor of the provider. */
  ScopeEditor: ComponentType<SourceScopeEditorProps>
  /**
   * True when the scope editor reads no admin-only route. Most editors list
   * the content of the connection, and only an owner or admin can read
   * those lists, so a member sees "Ask an admin" in place of them.
   */
  memberCanPick?: true
}

export const SOURCE_PROVIDER_UI: Record<SourceProvider, SourceProviderUi> = {
  github: githubSourceUi,
  confluence: confluenceSourceUi,
  linear: linearSourceUi,
  notion: notionSourceUi,
  slack: slackSourceUi,
  pagerduty: pagerdutySourceUi,
  plain: plainSourceUi,
  git: gitSourceUi,
}

export function sourceProviderLabel(provider: SourceProvider): string {
  return SOURCE_SCOPES[provider].label
}

/** The anchor of a provider section in the Workspace settings pane. */
export function sourceAnchorId(provider: SourceProvider): string {
  return `source-${provider}`
}

/** The settings pane link of a Workspace, scrolled to one provider section. */
export function workspaceSourceHref(
  orgSlug: string,
  workspaceSlug: string,
  provider: SourceProvider,
): string {
  return `/${orgSlug}/ws/${workspaceSlug}?pane=settings#${sourceAnchorId(provider)}`
}
