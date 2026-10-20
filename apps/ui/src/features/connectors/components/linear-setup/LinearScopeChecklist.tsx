import { Checkbox } from "@/components/ui/Checkbox"
import { CheckboxGroup } from "@/components/ui/CheckboxGroup"

const groups = [
  { type: "team", label: "Teams" },
  { type: "project", label: "Projects" },
] as const

export type LinearChecklistItem = {
  /** The checkbox value, unique in the list. */
  value: string
  type: (typeof groups)[number]["type"]
  title: string
  /** A team key or Linear id, shown in a monospace font. */
  code?: string | null
  detail?: string | null
}

/** The Linear team and project picker: one checkbox for each item. */
export function LinearScopeChecklist(props: {
  items: readonly LinearChecklistItem[]
  value: string[]
  onChange: (value: string[]) => void
  "aria-label": string
}) {
  const { items, value, onChange } = props
  return (
    <CheckboxGroup
      value={value}
      onChange={onChange}
      aria-label={props["aria-label"]}
      className="max-h-[min(48vh,28rem)] gap-0 overflow-y-auto border border-border"
    >
      {groups.map(({ type, label }) => {
        const group = items.filter((item) => item.type === type)
        if (group.length === 0) return null
        return (
          <section
            key={type}
            className="border-t border-border first:border-t-0"
          >
            <h3 className="ctx-label border-b border-border bg-card/40 px-3 py-2">
              {label}
            </h3>
            <div>
              {group.map((item) => (
                <Checkbox
                  key={item.value}
                  value={item.value}
                  className="w-full cursor-pointer items-start border-b border-border px-3 py-2 last:border-b-0 hover:bg-foreground/[0.03]"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-foreground">
                      {item.title}
                      {item.code ? (
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {item.code}
                        </span>
                      ) : null}
                    </span>
                    {item.detail ? (
                      <span className="block text-xs text-muted-foreground">
                        {item.detail}
                      </span>
                    ) : null}
                  </span>
                </Checkbox>
              ))}
            </div>
          </section>
        )
      })}
    </CheckboxGroup>
  )
}
