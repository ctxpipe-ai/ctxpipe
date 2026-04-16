import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * Users sometimes typo `/.auth/sign-out` as `/signout/...` (missing `.auth`).
 * Without this route, `/signout/chat/conv_...` matched `/$orgSlug/chat/$conversationId`
 * with orgSlug `signout`, which broke chat and did not run sign-out.
 */
export const Route = createFileRoute("/signout/$")({
  beforeLoad: () => {
    throw redirect({
      to: "/.auth/$authView",
      params: { authView: "sign-out" },
      replace: true,
    })
  },
})
