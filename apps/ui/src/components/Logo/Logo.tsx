import type { ImgHTMLAttributes } from "react"

export function Logo(props: ImgHTMLAttributes<HTMLImageElement>) {
  return <img src="/ctx_.svg" alt="" {...props} />
}
