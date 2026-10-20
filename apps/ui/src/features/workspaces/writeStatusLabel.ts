type WriteStatusTone =
  | "writable"
  | "pull_request"
  | "read_only"
  | "pending"
  | "check_failed"

/**
 * The write access label of a Workspace. `conversationWritable` is true when
 * the default branch is protected but a conversation can still push its own
 * branch and open a pull request: that is a normal state, not a fault.
 */
export function writeStatusLabel(
  status: string,
  readOnlyReason?: string | null,
  conversationWritable?: boolean,
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
      label: "Could not check write access",
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
  if (status === "read_only" && conversationWritable) {
    return {
      label: "Changes by pull request",
      tone: "pull_request",
      description:
        "The default branch is protected. A conversation pushes its own branch and opens a pull request.",
    }
  }
  return {
    label: "Read-only",
    tone: "read_only",
    description:
      readOnlyReason ?? "The GitHub App cannot push to this repository",
  }
}
