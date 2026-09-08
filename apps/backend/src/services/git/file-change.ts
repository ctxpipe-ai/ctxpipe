import { z } from "zod"

export const repositoryFilePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !path.includes("\\") &&
      path
        .split("/")
        .every(
          (part) =>
            part !== "" &&
            part !== "." &&
            part !== ".." &&
            part.toLowerCase() !== ".git",
        ),
    "A repository-relative file path is required",
  )

export const gitFileChangeSchema = z
  .object({
    path: repositoryFilePathSchema,
    content: z.string(),
    encoding: z.enum(["utf-8", "base64"]).optional(),
  })
  .strict()
  .refine(
    (file) =>
      file.encoding !== "base64" ||
      Buffer.from(file.content, "base64").toString("base64") === file.content,
    "A canonical base64 payload is required",
  )
export type GitFileChange = z.infer<typeof gitFileChangeSchema>
export function gitFileBytes(file: GitFileChange): Buffer {
  return Buffer.from(
    file.content,
    file.encoding === "base64" ? "base64" : "utf8",
  )
}
