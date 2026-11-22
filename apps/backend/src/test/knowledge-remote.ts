import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * A Git repository that a shallow fetch by SHA can read, and a fetch with no
 * blobs too. Each commit is one day after the commit before it, so each
 * commit has its own time.
 */
export class Remote {
  private commits = 0

  private constructor(readonly directory: string) {}

  /** The committer time of the commit `index` (from 0). */
  static timeOf(index: number): Date {
    return new Date(Date.UTC(2026, 0, 1 + index))
  }

  static async create(): Promise<Remote> {
    const remote = new Remote(
      await mkdtemp(join(tmpdir(), "knowledge-writer-")),
    )
    remote.git("init", "-q", "-b", "main")
    remote.git("config", "uploadpack.allowAnySHA1InWant", "true")
    remote.git("config", "uploadpack.allowFilter", "true")
    return remote
  }

  get url(): string {
    return pathToFileURL(this.directory).toString()
  }

  git(...args: string[]): string {
    const date = `@${Remote.timeOf(this.commits).getTime() / 1000} +0000`
    return execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-C",
        this.directory,
        ...args,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      },
    ).trim()
  }

  /** Write (text or bytes) or remove (null) each file, commit, and give the SHA. */
  async commit(files: Record<string, string | Buffer | null>): Promise<string> {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) this.git("rm", "-q", "--cached", path)
      else {
        await mkdir(dirname(join(this.directory, path)), { recursive: true })
        await writeFile(join(this.directory, path), content)
        this.git("add", path)
      }
    }
    this.git("commit", "-q", "--allow-empty", "-m", "change")
    this.commits++
    return this.git("rev-parse", "HEAD")
  }

  async remove(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true })
  }
}
