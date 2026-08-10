import { createFileRoute } from "@tanstack/react-router"

const NOTION_SETUP_RESULT_KEY = "notion-setup-result"

export const Route = createFileRoute("/.notion/setup")({
  component: () => null,
  server: {
    handlers: {
      GET: ({ request }) => notionSetupRelay(request),
    },
  },
})

function notionSetupRelay(request: Request): Response {
  const url = new URL(request.url)
  const orgSlug = url.searchParams.get("orgSlug")
  const connectionId = url.searchParams.get("connectionId")
  const error = url.searchParams.get("error")
  const redirectSearch = new URLSearchParams()

  if (connectionId) redirectSearch.set("notionConnectionId", connectionId)
  if (error) redirectSearch.set("error", error)

  const redirectPath = orgSlug
    ? `/${encodeURIComponent(orgSlug)}/connectors${
        redirectSearch.toString() ? `?${redirectSearch.toString()}` : ""
      }`
    : "/"

  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Notion connected</title>
  </head>
  <body>
    <script>
      (function () {
        try {
          window.localStorage.setItem(
            ${JSON.stringify(NOTION_SETUP_RESULT_KEY)},
            JSON.stringify(${JSON.stringify({ connectionId, error })})
          );
        } catch (_) {}
        window.close();
        window.setTimeout(function () {
          window.location.replace(${JSON.stringify(redirectPath)});
        }, 500);
      })();
    </script>
  </body>
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  )
}
