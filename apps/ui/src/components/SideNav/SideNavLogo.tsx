import { Link } from "react-aria-components"
import { twMerge } from "tailwind-merge"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { Logo } from "../Logo/Logo"

export function SideNavLogo({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="Home"
      className={twMerge(
        // Padding traded for margin so the focus ring stays inside the rail/viewport.
        "inline-flex items-center rounded-md px-2.5 py-1.5 mx-1 my-1 text-white transition-all",
        focusVisibleClassName,
        className,
      )}
    >
      <Logo aria-hidden="true" className="h-5 w-auto shrink-0" />
    </Link>
  )
}
