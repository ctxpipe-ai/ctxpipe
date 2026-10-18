import { useSyncExternalStore } from "react"

/** A yes/no mark that lasts for the browser session (one tab). */
function sessionFlag(key: string) {
  const store = () => {
    try {
      return globalThis.sessionStorage ?? null
    } catch {
      return null
    }
  }
  return {
    isSet: () => {
      try {
        return store()?.getItem(key) === "1"
      } catch {
        return false
      }
    },
    set: () => {
      try {
        store()?.setItem(key, "1")
      } catch {
        // Storage can be full or blocked. The flag only shapes a hint or a fade.
      }
    },
    clear: () => {
      try {
        store()?.removeItem(key)
      } catch {
        // See `set`.
      }
    },
  }
}

/** The user created a Workspace in this session: do not tell them to add one. */
export const workspaceCreatedFlag = sessionFlag("ctxpipe.workspace-created")

/** Onboarding opened Home: Home fades in one time, then clears the flag. */
export const onboardingHandOffFlag = sessionFlag("ctxpipe.onboarding-hand-off")

/**
 * Read a session flag in a component. The server render and the first client
 * render (hydration) read `false`, so their markup is the same. The real
 * value shows right after hydration. A flag change does not re-render.
 */
export function useSessionFlag(flag: { isSet: () => boolean }) {
  return useSyncExternalStore(subscribeNever, flag.isSet, () => false)
}

function subscribeNever() {
  return () => {}
}
