/**
 * Node fetch rejects the API client's relative URLs; msw needs absolute
 * ones. Returns a function that restores the original fetch.
 */
export function installRelativeFetch(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    original(
      (typeof input === "string" && input.startsWith("/")
        ? `http://localhost${input}`
        : input) as RequestInfo,
      init,
    )) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}
