import type { ImgHTMLAttributes } from "react"

export function Logo(props: ImgHTMLAttributes<HTMLImageElement>) {
  // The Vite base is "/" in the app and "./" in a Storybook build, so a
  // Storybook preview under a path prefix also loads the logo.
  return <img src={`${import.meta.env.BASE_URL}ctx_.svg`} alt="" {...props} />
}

/** The large logo at the top center of an auth card. */
export function AuthLogoBadge() {
  return (
    <div className="pointer-events-none absolute top-4 left-1/2 z-10 -translate-x-1/2">
      <Logo alt="ctxpipe" className="h-16 w-16 select-none" draggable={false} />
    </div>
  )
}
