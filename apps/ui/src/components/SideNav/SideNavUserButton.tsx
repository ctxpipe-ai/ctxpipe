"use client"

import {
  AuthUIContext,
  UserAvatar,
  UserView,
} from "@daveyplate/better-auth-ui"
import {
  IconLogout,
  IconSelector,
  IconSettings,
} from "@tabler/icons-react"
import { useContext, useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import {
  sideNavAccountAvatarClassNames,
  sideNavAccountTriggerClassName,
  sideNavAccountUserViewClassNames,
  sideNavTrailingSlotClassName,
} from "./sideNavStyles"

type SideNavUserButtonProps = {
  expanded: boolean
}

export function SideNavUserButton({ expanded }: SideNavUserButtonProps) {
  const {
    basePath,
    hooks: { useSession },
    localization,
    account: accountOptions,
    viewPaths,
    Link,
  } = useContext(AuthUIContext)
  const { data: sessionData, isPending } = useSession()
  const user = sessionData?.user
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const settingsHref = accountOptions
    ? `${accountOptions.basePath}/${accountOptions.viewPaths?.SETTINGS}`
    : null
  const signOutHref = `${basePath}/${viewPaths.SIGN_OUT}`

  return (
    <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
      <DropdownMenuTrigger
        aria-label={expanded ? "User menu" : "User"}
        render={
          <button
            type="button"
            className={cn(
              sideNavAccountTriggerClassName(expanded),
              "!bg-transparent shadow-none hover:!bg-teal-900/30 hover:!text-zinc-50",
            )}
          />
        }
      >
        {expanded ? (
          <>
            <UserView
              classNames={sideNavAccountUserViewClassNames}
              isPending={isPending}
              user={user}
            />
            <span className={sideNavTrailingSlotClassName}>
              <IconSelector
                className="size-4 text-zinc-400"
                stroke={1.4}
                aria-hidden
              />
            </span>
          </>
        ) : (
          <UserAvatar
            classNames={sideNavAccountAvatarClassNames}
            isPending={isPending}
            user={user}
          />
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent className="rounded-lg" align="end" side="right">
        <div className="p-2">
          {(user && !user.isAnonymous) || isPending ? (
            <UserView
              classNames={sideNavAccountUserViewClassNames}
              isPending={isPending}
              user={user}
            />
          ) : (
            <div className="-my-1 text-xs text-muted-foreground">
              {localization.ACCOUNT}
            </div>
          )}
        </div>

        <DropdownMenuSeparator />

        {settingsHref ? (
          <Link href={settingsHref}>
            <DropdownMenuItem
              className="rounded-lg"
              onClick={() => setDropdownOpen(false)}
            >
              <IconSettings className="size-4" stroke={1.4} aria-hidden />
              {localization.SETTINGS}
            </DropdownMenuItem>
          </Link>
        ) : null}

        <Link href={signOutHref}>
          <DropdownMenuItem
            className="rounded-lg"
            onClick={() => setDropdownOpen(false)}
          >
            <IconLogout className="size-4" stroke={1.4} aria-hidden />
            {localization.SIGN_OUT}
          </DropdownMenuItem>
        </Link>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
