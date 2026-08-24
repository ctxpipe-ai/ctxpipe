export type FileTabSession = {
  tabs: string[]
  previewPath: string | null
}

/** Single click: reuse the unlocked preview tab, or select an already-open file. */
export function previewFile(
  session: FileTabSession,
  path: string,
): FileTabSession {
  if (session.tabs.includes(path) && session.previewPath !== path) {
    return session
  }
  if (session.previewPath === path) return session
  if (session.previewPath && session.tabs.includes(session.previewPath)) {
    return {
      tabs: session.tabs.map((item) =>
        item === session.previewPath ? path : item,
      ),
      previewPath: path,
    }
  }
  if (session.tabs.includes(path)) {
    return { tabs: session.tabs, previewPath: path }
  }
  return { tabs: [...session.tabs, path], previewPath: path }
}

/** Double click: keep the tab open when the next file is previewed. */
export function pinFile(session: FileTabSession, path: string): FileTabSession {
  const tabs = session.tabs.includes(path)
    ? session.tabs
    : [...session.tabs, path]
  return {
    tabs,
    previewPath: session.previewPath === path ? null : session.previewPath,
  }
}

/** Include a URL-selected file so the next preview can replace it. */
export function seedFileTabSession(
  session: FileTabSession,
  panePath: string | null,
): FileTabSession {
  if (!panePath || session.tabs.includes(panePath)) return session
  return {
    tabs: [...session.tabs, panePath],
    previewPath: session.previewPath ?? panePath,
  }
}

export function closeFileTab(
  session: FileTabSession,
  path: string,
): FileTabSession {
  return {
    tabs: session.tabs.filter((item) => item !== path),
    previewPath: session.previewPath === path ? null : session.previewPath,
  }
}

export function tabsIncludingPanePath(
  tabs: readonly string[],
  path: string | null,
): string[] {
  if (!path || tabs.includes(path)) return [...tabs]
  return [...tabs, path]
}
