const ONBOARDING_STORAGE_PREFIX = "ctxpipe:onboarding:v1:completed"
const HOME_FADE_STORAGE_KEY = "ctxpipe:onboarding:v1:home-fade-pending"

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

export function markHomepageFadePending() {
  if (typeof window === "undefined") return
  try {
    window.sessionStorage.setItem(HOME_FADE_STORAGE_KEY, "1")
  } catch {
    // ignore storage errors in brittle MVP flow
  }
}

export function consumeHomepageFadePending() {
  if (typeof window === "undefined") return false
  try {
    const pending = window.sessionStorage.getItem(HOME_FADE_STORAGE_KEY) === "1"
    if (pending) {
      window.sessionStorage.removeItem(HOME_FADE_STORAGE_KEY)
    }
    return pending
  } catch {
    return false
  }
}
