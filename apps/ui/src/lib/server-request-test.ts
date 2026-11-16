import { requestHandler } from "@tanstack/react-start/server"

/** Headers of a signed-in browser: a Better Auth session cookie. */
export const signedInHeaders = {
  cookie: "__Secure-better-auth.session_token=tok_1",
}

/**
 * Runs `work` inside a real Start server request with these incoming
 * headers, as a server render does, and returns its result.
 */
export async function duringServerRequest<T>(
  headers: Record<string, string>,
  work: () => Promise<T>,
): Promise<T> {
  let outcome: { value: T } | { error: unknown } | undefined
  const handle = requestHandler(async () => {
    outcome = await work().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    return new Response(null, { status: 204 })
  })
  await handle(new Request("http://ui.test/acme", { headers }), {})
  if (!outcome) throw new Error("The request handler did not run")
  if ("error" in outcome) throw outcome.error
  return outcome.value
}
