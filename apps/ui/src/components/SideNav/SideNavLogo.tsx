import { Link } from "react-aria-components"
import { twMerge } from "tailwind-merge"
import { Logo } from "../Logo/Logo"

export function SideNavLogo({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="Home"
      className={twMerge(
        "inline-flex items-center py-4.5 px-3.5 text-white transition-all ",
        className,
      )}
    >
      <Logo aria-hidden="true" className="h-5 w-auto shrink-0" />
    </Link>
  )
}
