import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Radio, RadioGroup } from "@/components/ui/RadioGroup"

export type OAuthOrganizationOption = {
  id: string
  name: string
  slug: string
}

export function OAuthOrganizationSelector({
  organizations,
  error = null,
  isSubmitting = false,
  onContinue,
}: {
  organizations: OAuthOrganizationOption[]
  error?: string | null
  isSubmitting?: boolean
  onContinue: (organizationId: string) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  return (
    <main className="mx-auto max-w-xl px-6 py-16 text-foreground">
      <section className="space-y-6 rounded-none border border-border bg-card/80 p-6">
        <div className="space-y-2">
          <p className="ctx-label">OAuth connection</p>
          <h1 className="text-xl font-medium">Choose an organisation</h1>
          <p className="text-sm text-muted-foreground">
            Claude will use ctx| data from this organisation. The choice is
            bound to this connection and will not change when you switch
            organisations later.
          </p>
        </div>

        {organizations.length > 0 ? (
          <RadioGroup
            aria-label="Organisation"
            value={selectedId ?? ""}
            onChange={(value) => setSelectedId(String(value))}
          >
            {organizations.map((organization) => (
              <Radio
                key={organization.id}
                value={organization.id}
                className="rounded-none border border-border bg-background/35 p-3 hover:bg-foreground/[0.04]"
              >
                <span className="min-w-0">
                  <span className="block font-medium text-foreground">
                    {organization.name}
                  </span>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {organization.slug}
                  </span>
                </span>
              </Radio>
            ))}
          </RadioGroup>
        ) : (
          <InlineAlert
            variant="warning"
            title="No organisations available"
            actions={
              <Button
                href="/onboarding"
                variant="outline"
                className="rounded-none"
              >
                Open ctx| setup
              </Button>
            }
          >
            Create or join an organisation, then reconnect Claude.
          </InlineAlert>
        )}

        {error ? (
          <InlineAlert variant="error" title="Could not continue">
            {error}
          </InlineAlert>
        ) : null}

        {organizations.length > 0 ? (
          <div className="flex justify-end">
            <Button
              className="rounded-none"
              isDisabled={!selectedId || isSubmitting}
              isPending={isSubmitting}
              onPress={() => {
                if (selectedId) onContinue(selectedId)
              }}
            >
              Continue
            </Button>
          </div>
        ) : null}
      </section>
    </main>
  )
}
