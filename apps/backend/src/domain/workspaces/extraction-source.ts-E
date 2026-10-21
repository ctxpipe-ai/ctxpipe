import { z } from "zod"
import { ingestSourceSchema } from "../ingestion/ingestion-run.js"
import { gitObjectIdSchema } from "./revision.js"

/**
 * The source of a publish from an ingestion v2 run (ADR-052 section 6, T21):
 * the run, and the tip of its assembled ref in the Workspace repository. The
 * publish replays the delta from the pinned revision (the command's revision)
 * to `tip`. It keeps each file that the delta deletes in a root of
 * `withheldRoots`: a failed root gets no retraction (concept section 7.3).
 * `source`, `sourcePath`, `sourceSha`, and `bundle` are for the patch
 * validator of a semantic merge. `sourcePath` is the source file of the
 * run's repository in this Workspace (ADR-050 revision 2026-10-16).
 */
export const ingestPublishSourceSchema = z
  .object({
    runId: z.string().min(1),
    tip: gitObjectIdSchema,
    withheldRoots: z.array(z.string().min(1)),
    bundle: z.string().min(1),
    /** A GitHub or a plain git source (CTX-815). */
    source: ingestSourceSchema,
    sourcePath: z.string().min(1),
    sourceSha: gitObjectIdSchema,
    /** The run's author time: the commit date, so a replay makes the same SHA. */
    authorTime: z.string().datetime(),
  })
  .strict()

export type IngestPublishSource = z.infer<typeof ingestPublishSourceSchema>
