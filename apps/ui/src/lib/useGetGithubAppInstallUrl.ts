import { useMemo } from "react"

const PROD_GITHUB_CONNECT_HREF =
  "https://github.com/apps/ctxpipe-agent/installations/select_target"
const LOCAL_GITHUB_CONNECT_HREF =
  "https://github.com/apps/ctxpipe-agent-localhost/installations/select_target"

export function useGetGithubAppInstallUrl() {
  return useMemo(() => {
    if (typeof window === "undefined") return PROD_GITHUB_CONNECT_HREF

    const host = window.location.hostname
    const isLocalhost = host === "localhost" || host === "127.0.0.1"
    return isLocalhost ? LOCAL_GITHUB_CONNECT_HREF : PROD_GITHUB_CONNECT_HREF
  }, [])
}

