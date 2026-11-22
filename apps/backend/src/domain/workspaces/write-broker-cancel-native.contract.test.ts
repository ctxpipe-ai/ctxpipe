import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { pushWorkspaceCommit, writeJobRef } from "./write-broker.js"

/*
 * A cancel of an ingestion publish (CTX-1507) at the write broker, with real
 * git. The publish step can be in progress when its run is canceled: the
 * broker runs its push through the fence of the writer, after its checks
 * and the credential, and the fence of a canceled writer does not push.
 */

it(
  "the write broker does not push the commit of a canceled writer",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [{ path: "knowledge/notes.md", body: "# Notes\n" }],
      },
      async (f) => {
        await f.handle.cancel()
        f.git("reset", "--hard", f.sha)
        writeFileSync(join(f.directory, "knowledge/notes.md"), "# Changed\n")
        f.git("add", "-A")
        f.git("commit", "-m", "Publish the run")
        // The broker reads the commit from its job ref (CTX-1235).
        const sha = f.git("rev-parse", "HEAD")
        f.git("push", f.remote, `${sha}:${writeJobRef(`wjob_${f.id}`, sha)}`)
        const committed = {
          sha,
          tree: f.git("rev-parse", "HEAD^{tree}"),
          root: "",
          base: f.sha,
        }
        const push = (canceled: boolean) =>
          withOrgIdContext(f.org, () =>
            pushWorkspaceCommit(
              { orgId: f.org.id, workspaceId: f.workspaceId },
              { ...f.revision, access: "write-default" },
              committed,
              parseEnv(process.env),
              async (effect) => {
                // As `whileWorkflowRunActive` of a canceled run.
                if (canceled) throw new Error("The run ended before the push")
                await effect()
              },
            ),
          )
        await expect(push(true)).rejects.toThrow(/ended before the push/)
        expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
        // The same commit lands when the writer was not canceled: only the
        // cancel stopped it.
        await push(false)
        expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(sha)
      },
    )
  },
)
