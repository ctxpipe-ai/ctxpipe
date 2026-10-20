import { z } from "zod"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

/** Repository declarations must be checkoutable and must never carry credentials. */
export const linkedRepositoryUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((raw) => {
    if (/[\s\p{Cc}]/u.test(raw)) return false
    const scp = raw.match(/^git@([^:]+):(.+)$/)
    try {
      const url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : raw)
      return (
        ["https:", "http:", "ssh:", "git:"].includes(url.protocol) &&
        Boolean(url.hostname) &&
        url.pathname !== "/" &&
        url.pathname !== "" &&
        !url.password &&
        (!url.username ||
          (url.protocol === "ssh:" && url.username === "git")) &&
        !url.search &&
        !url.hash
      )
    } catch {
      return false
    }
  }, "A repository URL without credentials, query parameters, or fragments is required")
  .transform(normalizeWorkspaceRepositoryUrl)
