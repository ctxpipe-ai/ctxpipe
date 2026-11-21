import type { ImgHTMLAttributes } from "react"

export function Logo(props: ImgHTMLAttributes<HTMLImageElement>) {
  // The Vite base is "/" in the app and "./" in a Storybook build, so a
  // Storybook preview under a path prefix also loads the logo.
  return <img src={`${import.meta.env.BASE_URL}ctx_.svg`} alt="" {...props} />
}
