/**
 * Example tasks for a new Workspace conversation. The short label shows on a
 * pill under the composer; a click puts the full prompt in the composer.
 */
export const workspaceSuggestions = [
  {
    label: "Find unused files",
    prompt: "Find stale or unused files, and propose what to archive.",
  },
  {
    label: "Find conflicting files",
    prompt:
      "Identify knowledge files that disagree with each other, and propose one version.",
  },
  {
    label: "Summarize last week",
    prompt: "Summarize what happened across the platform last week",
  },
] as const
