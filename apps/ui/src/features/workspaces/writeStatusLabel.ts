export type WriteStatusTone = "writable" | "read_only" | "pending"

export function writeStatusLabel(status: string): {
  label: string
  tone: WriteStatusTone
} {
  if (status === "writable") {
    return { label: "Writable", tone: "writable" }
  }
  if (status === "unknown") {
    return { label: "Checking write access", tone: "pending" }
  }
  return { label: "Read-only", tone: "read_only" }
}
