export function httpWideEventMessage(input: {
  method?: unknown
  path?: unknown
  status?: unknown
}): string | undefined {
  if (typeof input.method !== "string" || typeof input.path !== "string") {
    return undefined
  }
  const status =
    typeof input.status === "number"
      ? String(input.status)
      : typeof input.status === "string"
        ? input.status
        : ""
  return status
    ? `${input.method} ${input.path} ${status}`
    : `${input.method} ${input.path}`
}
