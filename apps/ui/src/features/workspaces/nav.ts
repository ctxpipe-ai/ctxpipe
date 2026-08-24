export type WorkspaceTitleAction = "compose" | "toggle" | "resume"

export function workspaceTitleAction(input: {
  workspaceCount: number
  isCurrent: boolean
}): WorkspaceTitleAction {
  if (input.workspaceCount <= 1) return "compose"
  if (input.isCurrent) return "toggle"
  return "resume"
}

export function isWorkspaceNavOpen(input: {
  workspaceCount: number
  userExpanded: boolean
}): boolean {
  if (input.workspaceCount <= 1) return true
  return input.userExpanded
}
