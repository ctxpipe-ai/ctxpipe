import { ApiError } from "@/lib/api-result"

/** Why accepting an invitation failed, as the page tells the invitee. */
export type InviteAcceptError =
  | { kind: "account-exists" }
  | { kind: "invalid-password" }
  | { kind: "invitation-unavailable" }
  | { kind: "wrong-recipient" }
  | { kind: "failed" }

/**
 * The Better Auth error code of a failed request. The Better Auth client
 * (`throw: true`) puts the response body on `error`, and its `message` is
 * only the HTTP status text. `ApiError` keeps the body on `body`.
 */
function errorCode(error: unknown): string | null {
  if (error instanceof ApiError) return error.body.code ?? null
  if (typeof error !== "object" || error == null) return null
  const body = (error as { error?: unknown }).error
  if (typeof body !== "object" || body == null) return null
  const code = (body as { code?: unknown }).code
  return typeof code === "string" ? code : null
}

export function inviteAcceptError(error: unknown): InviteAcceptError {
  // The public invitation route answers 404 for an expired, used, or
  // canceled invitation.
  if (error instanceof ApiError && error.status === 404) {
    return { kind: "invitation-unavailable" }
  }
  switch (errorCode(error)) {
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return { kind: "account-exists" }
    case "INVALID_PASSWORD":
    case "PASSWORD_TOO_SHORT":
    case "PASSWORD_TOO_LONG":
      return { kind: "invalid-password" }
    case "INVITATION_NOT_FOUND":
      return { kind: "invitation-unavailable" }
    case "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION":
      return { kind: "wrong-recipient" }
    default:
      return { kind: "failed" }
  }
}
