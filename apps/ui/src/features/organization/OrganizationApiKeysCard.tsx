/**
 * Shared personal and organisation API-key UI.
 *
 * Replaces better-auth-ui's <ApiKeysCard> so both ownership modes share one
 * information hierarchy and empty state. The library card's
 * `CreateApiKeyDialog` gates an organisation/personal selector on
 * `contextOrganization.apiKey` (no per-call-site opt-out). That selector would
 * mix ownership modes on both settings pages. Calling
 * `authClient.apiKey.{list,create,delete}` with an explicit config keeps each
 * page scoped to its intended owner.
 *
 * The "Admin or owner required" branch is enforced by the backend
 * `organizationRoles` config (apps/backend/src/auth/config.ts) which only
 * grants `apiKey` actions to owner/admin — this card surfaces that 403.
 */
import { IconCopy, IconKey, IconTrash } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { AlertDialog } from "@/components/ui/AlertDialog"
import { Button } from "@/components/ui/Button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog"
import { Form } from "@/components/ui/Form"
import { GridList, GridListItem } from "@/components/ui/GridList"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Modal } from "@/components/ui/Modal"
import { Select, SelectItem } from "@/components/ui/Select"
import { ShimmerPlaceholder } from "@/components/ui/ShimmerPlaceholder"
import { TextField } from "@/components/ui/TextField"
import { betterAuthShellClassNames } from "@/features/auth/betterAuthShellClassNames"
import {
  organizationApiKeyLocalization,
  personalApiKeyLocalization,
} from "@/features/organization/apiKeyCopy"
import {
  type ApiKey,
  createOrganizationApiKey,
  createPersonalApiKey,
  deleteOrganizationApiKey,
  deletePersonalApiKey,
  listOrganizationApiKeys,
  listPersonalApiKeys,
} from "@/features/organization/organizationApiKeys"
import { cn } from "@/lib/utils"

const apiKeysCardClassNames = betterAuthShellClassNames.card

const EXPIRY_OPTIONS = [
  { id: "1", label: "1 day" },
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
  { id: "60", label: "60 days" },
  { id: "90", label: "90 days" },
  { id: "180", label: "180 days" },
  { id: "365", label: "1 year" },
  { id: "never", label: "Never expires" },
] as const

type ExpiryOptionId = (typeof EXPIRY_OPTIONS)[number]["id"]

function apiKeysQueryKey(
  kind: "personal" | "organization",
  organizationId?: string,
) {
  return ["api-keys", kind, organizationId ?? null] as const
}

function errorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.length > 0
  ) {
    return error.message
  }
  if (error instanceof Error && error.message.length > 0) return error.message
  return "Could not complete that request."
}

function isForbidden(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const status =
    "status" in error
      ? error.status
      : "statusCode" in error
        ? error.statusCode
        : undefined
  if (status === 403) return true
  const message = errorMessage(error)
  return (
    message.includes("INSUFFICIENT_API_KEY_PERMISSIONS") ||
    message.includes("FORBIDDEN")
  )
}

function expirySeconds(expiry: ExpiryOptionId): number | null {
  if (expiry === "never") return null
  return Number.parseInt(expiry, 10) * 24 * 60 * 60
}

function formatExpiry(expiresAt: Date | string | null | undefined): string {
  if (!expiresAt) return "Never expires"
  const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return "Never expires"
  return `Expires ${date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`
}

type ApiKeysCardProps =
  | { kind: "personal" }
  | { kind: "organization"; organizationId: string }

export function PersonalApiKeysCard() {
  return <ApiKeysCard kind="personal" />
}

export function OrganizationApiKeysCard(props: { organizationId: string }) {
  return (
    <ApiKeysCard kind="organization" organizationId={props.organizationId} />
  )
}

function ApiKeysCard(props: ApiKeysCardProps) {
  const isOrganization = props.kind === "organization"
  const organizationId = isOrganization ? props.organizationId : undefined
  const localization = isOrganization
    ? organizationApiKeyLocalization
    : personalApiKeyLocalization
  const queryKey = apiKeysQueryKey(props.kind, organizationId)
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [keyToRevoke, setKeyToRevoke] = useState<ApiKey | null>(null)
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)

  const keysQuery = useQuery({
    queryKey,
    queryFn: () =>
      props.kind === "organization"
        ? listOrganizationApiKeys(props.organizationId)
        : listPersonalApiKeys(),
  })

  const createMutation = useMutation({
    mutationFn: (input: { name: string; expiresIn: number | null }) =>
      props.kind === "organization"
        ? createOrganizationApiKey({
            organizationId: props.organizationId,
            name: input.name,
            expiresIn: input.expiresIn,
          })
        : createPersonalApiKey(input),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({
        queryKey,
      })
      setCreateOpen(false)
      setCreatedSecret(created.key ?? null)
    },
  })

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) =>
      isOrganization
        ? deleteOrganizationApiKey(keyId)
        : deletePersonalApiKey(keyId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey,
      })
      setKeyToRevoke(null)
    },
  })

  const keys = keysQuery.data ?? []
  const forbidden =
    isOrganization && keysQuery.error != null && isForbidden(keysQuery.error)
  const loadError = keysQuery.error != null && !forbidden

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <Card
        className={cn(
          apiKeysCardClassNames?.base,
          // Match Better Auth settings cards: hairline border, no ring/crosses.
          "ring-0 [&>span[aria-hidden]]:hidden",
        )}
      >
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription className="max-w-prose space-y-2">
            <p>{localization.API_KEYS_DESCRIPTION}</p>
            <p>
              Send it as{" "}
              <code className="font-mono text-xs text-foreground/80">
                x-api-key
              </code>
              , or{" "}
              <code className="font-mono text-xs text-foreground/80">
                Bearer
              </code>{" "}
              to MCP.{" "}
              {isOrganization ? (
                <Link
                  to="/.auth/account/$accountView"
                  params={{ accountView: "api-keys" }}
                  className="font-medium text-teal-400 underline-offset-4 hover:underline"
                >
                  Use a personal key instead.
                </Link>
              ) : (
                <Link
                  to="/.auth/organization/$organizationView"
                  params={{ organizationView: "api-keys" }}
                  className="font-medium text-teal-400 underline-offset-4 hover:underline"
                >
                  Use an organisation key instead.
                </Link>
              )}
            </p>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {keysQuery.isPending ? (
            <div aria-hidden className="flex flex-col gap-3">
              {[1, 2, 3].map((row) => (
                <div key={row} className="flex flex-col gap-2 py-2">
                  <ShimmerPlaceholder className="h-4 w-40 max-w-full" />
                  <ShimmerPlaceholder className="h-3 w-28" />
                </div>
              ))}
            </div>
          ) : forbidden ? (
            <InlineAlert variant="error" title="Admin or owner required">
              Only organisation admins and owners can manage these keys.
            </InlineAlert>
          ) : loadError ? (
            <InlineAlert variant="error" title="Could not load API keys">
              {errorMessage(keysQuery.error)}. Refresh the page and try again.
            </InlineAlert>
          ) : keys.length === 0 ? (
            <div className="flex max-w-prose items-start gap-3">
              <span className="ctx-node h-9 w-9 shrink-0">
                <IconKey className="size-4 text-muted-foreground" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-medium text-foreground">
                  No {isOrganization ? "organisation" : "personal"} keys
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {isOrganization
                    ? "Create one for CI or a shared agent."
                    : "Create one for your own scripts or agents."}
                </p>
              </div>
            </div>
          ) : (
            <GridList
              aria-label={
                isOrganization ? "Organisation API keys" : "Personal API keys"
              }
              className={cn(
                apiKeysCardClassNames?.cell,
                "bg-transparent dark:bg-transparent",
              )}
            >
              {keys.map((apiKey) => (
                <GridListItem
                  key={apiKey.id}
                  id={apiKey.id}
                  textValue={apiKey.name ?? apiKey.start ?? apiKey.id}
                  className="rounded-none border-border"
                >
                  <IconKey
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-sm">
                      {apiKey.name || "Unnamed key"}
                    </p>
                    <p className="truncate font-mono text-xs tabular-nums text-muted-foreground">
                      {apiKey.start ? `${apiKey.start}******` : "Prefix hidden"}
                      <span className="mx-1.5 text-zinc-600">·</span>
                      {formatExpiry(apiKey.expiresAt)}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    className="rounded-none"
                    onPress={() => setKeyToRevoke(apiKey)}
                  >
                    <IconTrash className="size-4" aria-hidden />
                    Revoke
                  </Button>
                </GridListItem>
              ))}
            </GridList>
          )}
        </CardContent>
        <CardFooter
          className={cn(
            apiKeysCardClassNames?.footer,
            "justify-end border-t py-4",
          )}
        >
          <Button
            variant="primary"
            className="rounded-none"
            onPress={() => {
              createMutation.reset()
              setCreateOpen(true)
            }}
          >
            Create API key
          </Button>
        </CardFooter>
      </Card>

      <CreateApiKeyModal
        isOpen={createOpen}
        isPending={createMutation.isPending}
        error={
          createMutation.error
            ? isOrganization && isForbidden(createMutation.error)
              ? "Only organisation admins and owners can mint organisation keys."
              : errorMessage(createMutation.error)
            : undefined
        }
        onOpenChange={(open) => {
          if (createMutation.isPending) return
          setCreateOpen(open)
          if (!open) createMutation.reset()
        }}
        onSubmit={(input) => createMutation.mutate(input)}
      />

      {createdSecret ? (
        <Modal
          isOpen
          isDismissable
          onOpenChange={(open) => {
            if (!open) setCreatedSecret(null)
          }}
        >
          <CreatedSecretDialog
            secret={createdSecret}
            onDone={() => setCreatedSecret(null)}
          />
        </Modal>
      ) : null}

      {keyToRevoke ? (
        <Modal
          isOpen
          isDismissable={!revokeMutation.isPending}
          onOpenChange={(open) => {
            if (revokeMutation.isPending) return
            if (!open) {
              setKeyToRevoke(null)
              revokeMutation.reset()
            }
          }}
        >
          <AlertDialog
            title="Revoke API key?"
            variant="destructive"
            actionLabel={revokeMutation.isPending ? "Revoking…" : "Revoke key"}
            cancelLabel="Cancel"
            onAction={() => revokeMutation.mutate(keyToRevoke.id)}
          >
            {revokeMutation.error
              ? errorMessage(revokeMutation.error)
              : `${keyToRevoke.name || "This key"} (${keyToRevoke.start ?? "prefix hidden"}******) will stop authenticating immediately. This cannot be undone.`}
          </AlertDialog>
        </Modal>
      ) : null}
    </div>
  )
}

function CreateApiKeyModal(props: {
  isOpen: boolean
  isPending: boolean
  error: string | undefined
  onOpenChange: (open: boolean) => void
  onSubmit: (input: { name: string; expiresIn: number | null }) => void
}) {
  const { isOpen, isPending, error, onOpenChange, onSubmit } = props
  const [name, setName] = useState("")
  const [expiry, setExpiry] = useState<ExpiryOptionId>("30")
  const [touched, setTouched] = useState(false)

  const reset = () => {
    setName("")
    setExpiry("30")
    setTouched(false)
  }

  const nameError =
    touched && !name.trim() ? "Enter a name for this key." : undefined
  const expiresIn = expirySeconds(expiry)

  return (
    <Modal
      isOpen={isOpen}
      isDismissable={!isPending}
      onOpenChange={(open) => {
        if (isPending) return
        if (!open) reset()
        onOpenChange(open)
      }}
    >
      <Dialog>
        <Form
          className="gap-5 p-0"
          onSubmit={(event) => {
            event.preventDefault()
            setTouched(true)
            const trimmed = name.trim()
            if (!trimmed) return
            onSubmit({ name: trimmed, expiresIn })
          }}
        >
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Name the key and choose an expiry. The secret is shown once.
            </DialogDescription>
          </DialogHeader>
          {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}
          <TextField
            label="Name"
            value={name}
            onChange={(value) => {
              setName(value)
              setTouched(true)
            }}
            placeholder="ci-mcp"
            isRequired
            isDisabled={isPending}
            errorMessage={nameError}
            isInvalid={!!nameError}
            autoFocus
            className="[&_input]:rounded-none [&_input]:border-border [&_input]:bg-zinc-950 [&_input]:text-zinc-100 [&_label]:text-zinc-300"
          />
          <Select
            label="Expires"
            selectedKey={expiry}
            onSelectionChange={(key) => {
              if (typeof key === "string") setExpiry(key as ExpiryOptionId)
            }}
            isDisabled={isPending}
            className="w-full"
          >
            {EXPIRY_OPTIONS.map((option) => (
              <SelectItem
                key={option.id}
                id={option.id}
                textValue={option.label}
              >
                {option.label}
              </SelectItem>
            ))}
          </Select>
          {expiry === "never" ? (
            <InlineAlert variant="warning" title="Never-expiring key">
              This key will not expire. Treat it as a long-lived secret: store
              it in <code className="font-mono text-xs">CTXPIPE_API_KEY</code>,
              never in repository files, and revoke it if it leaks.
            </InlineAlert>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="quiet"
              className="rounded-none"
              isDisabled={isPending}
              onPress={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              className="rounded-none"
              isDisabled={isPending || !name.trim()}
              isPending={isPending}
            >
              Create API key
            </Button>
          </div>
        </Form>
      </Dialog>
    </Modal>
  )
}

function CreatedSecretDialog(props: { secret: string; onDone: () => void }) {
  const { secret, onDone } = props
  const [copied, setCopied] = useState(false)

  return (
    <Dialog>
      <DialogHeader>
        <DialogTitle>API key created</DialogTitle>
        <DialogDescription>
          Copy this secret now. Store it in{" "}
          <code className="font-mono text-xs">CTXPIPE_API_KEY</code> and never
          commit it; it will not be shown again.
        </DialogDescription>
      </DialogHeader>
      <p className="mt-4 break-all rounded-none border border-border bg-zinc-900 px-3 py-3 font-mono text-sm text-zinc-100">
        {secret}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button
          variant="outline"
          className="rounded-none"
          onPress={() => {
            void navigator.clipboard.writeText(secret)
            setCopied(true)
          }}
        >
          <IconCopy className="size-4" aria-hidden />
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="primary" className="rounded-none" onPress={onDone}>
          Done
        </Button>
      </div>
    </Dialog>
  )
}
