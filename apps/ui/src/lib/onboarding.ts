const ONBOARDING_STORAGE_PREFIX = "ctxpipe:onboarding:v1:completed"

function storageKey(userId?: string) {
  return userId ? `${ONBOARDING_STORAGE_PREFIX}:${userId}` : ONBOARDING_STORAGE_PREFIX
}

export function hasCompletedOnboarding(userId?: string) {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(storageKey(userId)) === "1"
  } catch {
    return false
  }
}

export function markOnboardingCompleted(userId?: string) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(storageKey(userId), "1")
  } catch {
    // ignore storage errors in brittle MVP flow
  }
}
