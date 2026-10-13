import { Checkbox } from "@/components/ui/Checkbox"
import { CheckboxGroup } from "@/components/ui/CheckboxGroup"

export type PickerOrganization = { id: string; name: string; slug: string }

/**
 * Check boxes for the orgs an OAuth connection can reach. The parent keeps
 * the value and blocks submit when no org is ticked.
 */
export function OrganizationPicker(props: {
  organizations: PickerOrganization[]
  value: string[]
  onChange: (organizationIds: string[]) => void
}) {
  const { organizations, value, onChange } = props
  return (
    <CheckboxGroup
      label="Organizations"
      value={value}
      onChange={onChange}
      isInvalid={value.length === 0}
      errorMessage="Select at least one organization."
    >
      {organizations.map((organization) => (
        <Checkbox key={organization.id} value={organization.id}>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-foreground">
              {organization.name}
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {organization.slug}
            </span>
          </span>
        </Checkbox>
      ))}
    </CheckboxGroup>
  )
}
