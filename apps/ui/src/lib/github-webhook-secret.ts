/**
 * Client-side secret for GitHub App webhooks. Sent to the API only when the user
 * saves credentials — not stored or logged by this helper.
 */
export function generateGithubWebhookSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}
