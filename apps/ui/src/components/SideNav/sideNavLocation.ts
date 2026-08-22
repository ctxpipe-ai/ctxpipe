export type SideNavPrimary = "home" | "connectors" | "workspace" | "other"

export type SideNavLocation = {
  orgSlug: string | null
  primary: SideNavPrimary
  workspaceSlug?: string
  conversationId?: string
}

export function parseSideNavLocation(
  pathname: string,
  fallbackOrg: string | null,
): SideNavLocation {
  const segments = pathname.split("/").filter(Boolean)
  const first = segments[0]
  const orgSlug =
    (!first?.startsWith(".") ? (first ?? null) : null) ?? fallbackOrg
  if (segments[1] === "connectors") {
    return { orgSlug, primary: "connectors" }
  }
  if (segments[1] === "ws" && segments[2]) {
    return {
      orgSlug,
      primary: "workspace",
      workspaceSlug: segments[2],
      conversationId: segments[3],
    }
  }
  if (!segments[1]) {
    return { orgSlug, primary: "home" }
  }
  return { orgSlug, primary: "other" }
}

export function sideNavLocationKey(location: SideNavLocation): string {
  return [
    location.orgSlug ?? "",
    location.primary,
    location.workspaceSlug ?? "",
    location.conversationId ?? "",
  ].join("/")
}
