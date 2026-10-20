import { IconDots } from "@tabler/icons-react"
import {
  type InfiniteData,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { Link } from "react-aria-components"
import { SideNavTooltip } from "@/components/SideNav/SideNavTooltip"
import type { SideNavLocation } from "@/components/SideNav/sideNavLocation"
import {
  sideNavLabelClassName,
  sideNavRowClassName,
} from "@/components/SideNav/sideNavStyles"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/Menu"
import { Modal } from "@/components/ui/Modal"
import { ApiError } from "@/lib/api-result"
import { ConversationNameInput } from "./ConversationNameInput"
import { conversationShortLabel } from "./conversationLabel"
import type { workspaceSearch } from "./pane"
import { deleteConversation, workspaceKeys } from "./queries"
import type { Workspace } from "./types"

type ConversationPage = { items: Array<{ id: string; name: string }> }

/** The cause and the next step for a failed delete. */
function deleteErrorText(error: Error): string {
  if (error instanceof ApiError && error.status === 409) {
    return "A turn is still running in this chat. Open the chat and select Stop, or wait until the turn ends. Then delete the chat again."
  }
  if (error instanceof ApiError && error.status === 0) {
    return "The request did not reach ctx|. Check your connection, then try again."
  }
  return `${error.message}. Try again. If the error stays, reload the page.`
}

/**
 * One chat in the Workspace chat list. The "more" menu shows on hover and on
 * keyboard focus, and has Rename and Delete.
 */
export function WorkspaceConversationRow(props: {
  orgSlug: string
  workspace: Workspace
  item: { id: string; name: string }
  active: boolean
  navExpanded: boolean
  href: string
  paneSearch: ReturnType<typeof workspaceSearch>
  prefetchConversation: (conversationId: string) => void
  onSelectNav: (next: SideNavLocation) => void
}) {
  const {
    orgSlug,
    workspace,
    item,
    active,
    navExpanded,
    href,
    paneSearch,
    prefetchConversation,
    onSelectNav,
  } = props
  const router = useRouter()
  const queryClient = useQueryClient()
  const listKey = workspaceKeys.conversations(orgSlug, workspace.id)
  const [isRenaming, setIsRenaming] = useState(false)
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false)
  // Enter and Escape in the name input return focus to the chat link.
  const restoreFocus = useRef(false)
  const linkRef = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (!isRenaming && restoreFocus.current) {
      restoreFocus.current = false
      linkRef.current?.focus()
    }
  }, [isRenaming])

  const remove = useMutation({
    mutationFn: () => deleteConversation(orgSlug, item.id),
    onSuccess: async () => {
      queryClient.setQueryData<InfiniteData<ConversationPage>>(
        listKey,
        (data) =>
          data && {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.filter((other) => other.id !== item.id),
            })),
          },
      )
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.list(orgSlug),
      })
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(orgSlug, workspace.slug),
      })
      if (active) {
        onSelectNav({
          orgSlug,
          primary: "workspace",
          workspaceSlug: workspace.slug,
        })
        await router.navigate({
          to: "/$orgSlug/ws/$workspaceSlug",
          params: { orgSlug, workspaceSlug: workspace.slug },
          search: paneSearch,
        })
      }
      queryClient.removeQueries({
        queryKey: ["conversation", orgSlug, item.id],
      })
    },
  })

  const onRenamed = (name: string) => {
    queryClient.setQueryData<InfiniteData<ConversationPage>>(
      listKey,
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((other) =>
              other.id === item.id ? { ...other, name } : other,
            ),
          })),
        },
    )
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.conversation(orgSlug, item.id, workspace.id),
    })
  }

  if (isRenaming) {
    return (
      <li className="relative mx-1.5 flex h-8 items-center pr-1 pl-8 text-sm">
        <ConversationNameInput
          orgSlug={orgSlug}
          conversationId={item.id}
          name={item.name}
          onRenamed={onRenamed}
          onDone={(options) => {
            restoreFocus.current = options.restoreFocus
            setIsRenaming(false)
          }}
          className="w-full px-1"
          errorClassName="absolute top-full left-8 right-1"
        />
      </li>
    )
  }

  const short = conversationShortLabel(item.name)
  return (
    <li
      className={[
        "group/row relative",
        remove.isPending ? "opacity-60" : "",
      ].join(" ")}
      aria-busy={remove.isPending || undefined}
    >
      <SideNavTooltip label={item.name} enabled={!navExpanded}>
        <Link
          ref={linkRef}
          href={href}
          onHoverStart={() => prefetchConversation(item.id)}
          onPress={() => {
            prefetchConversation(item.id)
            onSelectNav({
              orgSlug,
              primary: "workspace",
              workspaceSlug: workspace.slug,
              conversationId: item.id,
            })
          }}
          aria-current={active ? "page" : undefined}
          aria-label={item.name}
          className={sideNavRowClassName({ active })}
        >
          <span className="relative flex size-8 shrink-0 items-center justify-center">
            <span
              className={[
                "text-xs font-normal tracking-tight",
                active ? "text-zinc-100" : "text-zinc-300",
                // Overlay drawer (`max-md`) always shows names, never initials.
                navExpanded ? "opacity-0" : "opacity-100 max-md:opacity-0",
              ].join(" ")}
              aria-hidden
            >
              {short}
            </span>
          </span>
          <span
            className={[
              sideNavLabelClassName(navExpanded),
              "truncate pr-3 text-left group-focus-within/row:pr-9 group-hover/row:pr-9",
              active ? "text-zinc-100" : "",
            ].join(" ")}
            aria-hidden={!navExpanded}
          >
            {item.name}
          </span>
        </Link>
      </SideNavTooltip>
      <MenuTrigger placement="bottom end">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${item.name}`}
          isDisabled={remove.isPending}
          className={[
            "absolute top-0 right-1.5 z-20 size-8 min-w-8 text-zinc-400 opacity-0 hover:text-zinc-100 focus-visible:opacity-100 aria-expanded:opacity-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100",
            // The collapsed rail has no room. The overlay drawer shows names.
            navExpanded ? "" : "hidden max-md:inline-flex",
          ].join(" ")}
        >
          <IconDots className="size-4" aria-hidden />
        </Button>
        <Menu
          aria-label={`Actions for ${item.name}`}
          onAction={(key) => {
            // The menu returns focus to its button when it closes. Start the
            // edit after that, or the name input loses focus at once.
            if (key === "rename") setTimeout(() => setIsRenaming(true), 0)
            if (key === "delete") setIsConfirmingDelete(true)
          }}
        >
          <MenuItem id="rename">Rename</MenuItem>
          <MenuItem id="delete" className="!text-red-400">
            Delete
          </MenuItem>
        </Menu>
      </MenuTrigger>
      <Modal
        isOpen={isConfirmingDelete}
        onOpenChange={setIsConfirmingDelete}
        isDismissable
      >
        <AlertDialog
          title="Delete this chat?"
          variant="destructive"
          actionLabel="Delete chat"
          cancelLabel="Cancel"
          onAction={() => remove.mutate()}
        >
          This deletes “{item.name}” and its messages. You cannot undo this.
          Files that the chat already published to Git stay in place.
        </AlertDialog>
      </Modal>
      {remove.error ? (
        <div className="mx-1.5 mt-1 mb-1">
          <InlineAlert
            variant="error"
            title="The chat was not deleted"
            actions={
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onPress={() => {
                    remove.reset()
                    remove.mutate()
                  }}
                >
                  Try again
                </Button>
                <Button size="sm" variant="quiet" onPress={remove.reset}>
                  Dismiss
                </Button>
              </>
            }
          >
            {deleteErrorText(remove.error)}
          </InlineAlert>
        </div>
      ) : null}
    </li>
  )
}
