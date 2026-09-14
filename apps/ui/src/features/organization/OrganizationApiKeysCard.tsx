import { IconCopy, IconKey, IconTrash } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
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
import { authClient } from "@/lib/auth-client"

const ORG_API_KEY_CONFIG_ID = "organization"

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

type OrgApiKey = {
  id: string
  name?: string | null
  start?: string | null
  expiresAt?: Date | string | null
}

function orgApiKeysQueryKey(organizationId: string) {
  return ["organization-api-keys", organizationId] as const
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

async function listOrganizationApiKeys(organizationId: string) {
  const result = await authClient.apiKey.list({
    query: {
      configId: ORG_API_KEY_CONFIG_ID,
      organizationId,
    },
  })
  if (result.error) throw result.error
  const payload = result.data as { apiKeys?: OrgApiKey[] } | OrgApiKey[] | null
  if (Array.isArray(payload)) return payload
  return payload?.apiKeys ?? []
}

async function createOrganizationApiKey(input: {
  organizationId: string
  name: string
  expiresIn: number | null
}) {
  const created = (await authClient.apiKey.create({
    configId: ORG_API_KEY_CONFIG_ID,
    organizationId: input.organizationId,
    name: input.name,
    expiresIn: input.expiresIn ?? undefined,
    fetchOptions: { throw: true },
  })) as OrgApiKey & { key?: string; id: string }

  if (input.expiresIn === null && created.id) {
    await authClient.apiKey.update({
      keyId: created.id,
      configId: ORG_API_KEY_CONFIG_ID,
      expiresIn: null,
      fetchOptions: { throw: true },
    })
  }

  return created
}

async function deleteOrganizationApiKey(keyId: string) {
  await authClient.apiKey.delete({
    keyId,
    configId: ORG_API_KEY_CONFIG_ID,
    fetchOptions: { throw: true },
  })
}

export function OrganizationApiKeysCard(props: { organizationId: string }) {
  const { organizationId } = props
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [keyToRevoke, setKeyToRevoke] = useState<OrgApiKey | null>(null)
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)

  const keysQuery = useQuery({
    queryKey: orgApiKeysQueryKey(organizationId),
    queryFn: () => listOrganizationApiKeys(organizationId),
  })

  const createMutation = useMutation({
    mutationFn: (input: { name: string; expiresIn: number | null }) =>
      createOrganizationApiKey({
        organizationId,
        name: input.name,
        expiresIn: input.expiresIn,
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({
        queryKey: orgApiKeysQueryKey(organizationId),
      })
      setCreateOpen(false)
      setCreatedSecret(created.key ?? null)
    },
  })

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => deleteOrganizationApiKey(keyId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: orgApiKeysQueryKey(organizationId),
      })
      setKeyToRevoke(null)
    },
  })

  const keys = keysQuery.data ?? []
  const forbidden = keysQuery.error != null && isForbidden(keysQuery.error)
  const loadError = keysQuery.error != null && !forbidden

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <Card className="rounded-none">
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Organisation keys authenticate MCP as this organisation, not the
            person who minted them. Name each key. Keys last 30 days by default.
            Interpolate{" "}
            <code className="font-mono text-xs">CTXPIPE_API_KEY</code> in client
            config; do not put the key value in repository files.
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
              Only organisation admins and owners can list, mint, or revoke
              organisation keys. Ask an admin if you need a shared MCP key.
            </InlineAlert>
          ) : loadError ? (
            <InlineAlert variant="error" title="Could not load API keys">
              {errorMessage(keysQuery.error)}. Refresh the page and try again.
            </InlineAlert>
          ) : keys.length === 0 ? (
            <div className="max-w-prose">
              <p className="text-sm font-medium text-foreground">
                No organisation keys yet
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Mint a named key for CI, headless agents, or other machines that
                cannot sign in with OAuth.
              </p>
            </div>
          ) : (
            <GridList
              aria-label="Organisation API keys"
              className="rounded-none border-white/10 bg-transparent dark:bg-transparent"
            >
              {keys.map((apiKey) => (
                <GridListItem
                  key={apiKey.id}
                  id={apiKey.id}
                  textValue={apiKey.name ?? apiKey.start ?? apiKey.id}
                  className="rounded-none"
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
        <CardFooter>
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

      <CreateOrgApiKeyModal
        isOpen={createOpen}
        isPending={createMutation.isPending}
        error={
          createMutation.error
            ? isForbidden(createMutation.error)
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
              : `${keyToRevoke.name || "This key"} (${keyToRevoke.start ?? "prefix hidden"}******) will stop authenticating MCP immediately. This cannot be undone.`}
          </AlertDialog>
        </Modal>
      ) : null}
    </div>
  )
}

function CreateOrgApiKeyModal(props: {
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
              Give the key a name so you can tell it apart later. Keys last 30
              days unless you pick another expiry. Copy the secret once after
              minting.
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
          Copy the secret now — it is shown once. Interpolate{" "}
          <code className="font-mono text-xs">CTXPIPE_API_KEY</code> in MCP
          client config. Do not put the key value in repository files.
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
