export function workspaceDeleteNameMatches(
  typed: string,
  displayName: string,
): boolean {
  return typed.trim() === displayName
}
