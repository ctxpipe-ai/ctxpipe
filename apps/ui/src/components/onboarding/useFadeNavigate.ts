import { useCallback, useState } from "react"

export function useFadeNavigate() {
  const [completing, setCompleting] = useState(false)

  const fadeOutAndNavigate = useCallback((url: string) => {
    setCompleting(true)
    window.setTimeout(() => {
      sessionStorage.setItem("ctxpipe:app-shell-fade-in", "1")
      window.location.replace(url)
    }, 500)
  }, [])

  return { completing, setCompleting, fadeOutAndNavigate }
}
