export type WriteStatusTone =
  | "writable"
  | "read_only"
  | "pending"
  | "check_failed"

export function writeStatusLabel(
  status: string,
  readOnlyReason?: string | null,
): {
  label: string
  tone: WriteStatusTone
  description: string
} {
  if (status === "writable") {
    return {
      label: "Writable",
      tone: "writable",
      description: "The GitHub App can push to this repository",
    }
  }
  if (status === "unknown" && readOnlyReason) {
    return {
      label: "Write access not checked",
      tone: "check_failed",
      description: readOnlyReason,
    }
  }
  if (status === "unknown") {
    return {
      label: "Checking write access",
      tone: "pending",
      description:
        "Checking whether the GitHub App can push to this repository",
    }
  }
  return {
    label: "Read-only",
    tone: "read_only",
    description:
      readOnlyReason ?? "The GitHub App cannot push to this repository",
  }
}
