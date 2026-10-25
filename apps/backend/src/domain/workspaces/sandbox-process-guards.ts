import { type ChildProcessByStdio, spawn } from "node:child_process"
import { createServer } from "node:net"
import type { Writable } from "node:stream"

import type {
  SandboxHandle,
  SandboxProvider,
  SpawnHandle,
} from "@tanstack/ai-sandbox"

/**
 * Apply `wrap` to each handle that the provider gives. `createOptions`
 * changes the options of `create` and `restoreSnapshot`.
 */
export function wrapSandboxHandles(
  provider: SandboxProvider,
  wrap: (handle: SandboxHandle) => SandboxHandle | Promise<SandboxHandle>,
  createOptions: <T>(options: T) => T = (options) => options,
): SandboxProvider {
  const { restoreSnapshot } = provider
  return {
    name: provider.name,
    capabilities: () => provider.capabilities(),
    create: async (options) =>
      wrapHandle(await provider.create(createOptions(options))),
    resume: async (options) => {
      const handle = await provider.resume(options)
      return handle ? wrapHandle(handle) : handle
    },
    destroy: (options) => provider.destroy(options),
    ...(restoreSnapshot
      ? {
          restoreSnapshot: async (options) =>
            wrapHandle(
              await restoreSnapshot.call(provider, createOptions(options)),
            ),
        }
      : {}),
  }
  async function wrapHandle(handle: SandboxHandle): Promise<SandboxHandle> {
    const { snapshot, fork } = handle
    return wrap({
      ...handle,
      // Some handles keep these on a class prototype; spread drops them.
      ...(snapshot
        ? { snapshot: (label?: string) => snapshot.call(handle, label) }
        : {}),
      ...(fork
        ? { fork: async () => wrapHandle(await fork.call(handle)) }
        : {}),
      destroy: () => handle.destroy(),
    })
  }
}

function withSpawn(
  handle: SandboxHandle,
  spawnProcess: SandboxHandle["process"]["spawn"],
): SandboxHandle {
  return { ...handle, process: { ...handle.process, spawn: spawnProcess } }
}

/**
 * Local-process sandboxes start each process in its own process group, so no
 * signal reaches the group when this process dies. One watchdog per owner
 * reads a stdin pipe that only the owner holds. When the owner dies, the pipe
 * closes, and the watchdog kills each process group that is still registered.
 * A process that leaves its group is not stopped.
 */
export function withOwnerWatchdog(provider: SandboxProvider): SandboxProvider {
  return wrapSandboxHandles(provider, (handle) =>
    withSpawn(handle, async (command, options) => {
      const proc = await handle.process.spawn(command, options)
      watchProcessGroup(proc)
      return proc
    }),
  )
}

const watchedGroups = new Set<number>()
let ownerWatchdog: ChildProcessByStdio<Writable, null, null> | undefined

function watchProcessGroup(proc: SpawnHandle): void {
  if (process.platform === "win32" || !proc.pid) return
  const pid = proc.pid
  const input = ownerWatchdogInput()
  watchedGroups.add(pid)
  input.write(`+ ${pid}\n`)
  const release = () => {
    watchedGroups.delete(pid)
    if (ownerWatchdog?.stdin.writable) ownerWatchdog.stdin.write(`- ${pid}\n`)
  }
  proc.wait().then(release, release)
}

function ownerWatchdogInput(): Writable {
  if (ownerWatchdog) return ownerWatchdog.stdin
  const watchdog = spawn(
    "/bin/sh",
    [
      "-c",
      `live=' '
while read -r op p; do
  if [ "$op" = + ]; then live="$live$p "
  else case "$live" in *" $p "*) live="\${live%% $p *} \${live#* $p }";; esac
  fi
done
for p in $live; do kill -KILL -"$p" 2>/dev/null; done`,
    ],
    { detached: true, stdio: ["pipe", "ignore", "ignore"] },
  )
  watchdog.on("error", () => undefined)
  watchdog.stdin.on("error", () => undefined)
  // When the watchdog dies, the next process starts a new one that also
  // watches the groups that still run.
  watchdog.once("exit", () => {
    if (ownerWatchdog === watchdog) ownerWatchdog = undefined
  })
  watchdog.unref()
  ;(watchdog.stdin as { unref?: () => void }).unref?.()
  ownerWatchdog = watchdog
  for (const pid of watchedGroups) watchdog.stdin.write(`+ ${pid}\n`)
  return watchdog.stdin
}

/**
 * A reused sandbox can still run the `opencode serve` of a turn whose backend
 * died, and that server holds the agent port. Stop it before a new server
 * starts. Use this only where one conversation owns the sandbox.
 */
export function withSingleOpencodeServer(
  provider: SandboxProvider,
): SandboxProvider {
  return wrapSandboxHandles(provider, (handle) =>
    withSpawn(handle, async (command, options) => {
      if (command.startsWith("opencode serve "))
        await handle.process.exec(STOP_EARLIER_OPENCODE_SERVERS)
      return handle.process.spawn(command, options)
    }),
  )
}

// The match text is split, so this script does not match its own command.
const STOP_EARLIER_OPENCODE_SERVERS = `s=serve
found() {
  for d in /proc/[0-9]*; do
    [ "\${d#/proc/}" = "$$" ] && continue
    case "$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null)" in
      *opencode*" $s --hostname="*) echo "\${d#/proc/}" ;;
    esac
  done
}
for p in $(found); do kill -KILL "$p" 2>/dev/null; done
i=0
while [ -n "$(found)" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
true`

/**
 * Stop every process that the agent user started in an earlier turn: a
 * process can leave its server's process group and session (`setsid`,
 * `nohup`), and it would then send requests during the next turn, when the
 * firewall adds that turn's credentials.
 *
 * A process is stopped when all of these are true:
 * - The agent user (the user that runs this command) owns it. Root daemons
 *   and kernel threads are kept.
 * - It is not in the session of PID 1. The sandbox's own processes (PID 1
 *   and the keep-alive it starts) are in that session. Another process
 *   cannot join it: `setsid` only makes a new session.
 * - It is not in this command's process group (this script and its pipes),
 *   and it is not an ancestor of this command (the command runner).
 *
 * The conversation lock is held, so no command of this turn runs yet. The
 * script repeats until no such process is left, so a process that forks
 * while it is stopped is also stopped.
 */
export async function stopEarlierTurnProcesses(
  handle: SandboxHandle,
): Promise<void> {
  const result = await handle.process.exec(STOP_EARLIER_TURN_PROCESSES)
  if (result.exitCode !== 0)
    throw new Error(
      `Stopping the processes of an earlier turn failed: ${result.stderr.trim()}`,
    )
}

// After the command name in parentheses, /proc/<pid>/stat has the state,
// the parent, the process group and the session, in that order.
const STOP_EARLIER_TURN_PROCESSES = `field() { sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f"$2"; }
me=$(id -u)
init_session=$(field 1 4)
own_group=$(field $$ 3)
keep=" "
p=$$
while [ -n "$p" ] && [ "$p" -gt 1 ]; do
  keep="$keep$p "
  p=$(field "$p" 2)
done
found() {
  for d in /proc/[0-9]*; do
    p=\${d#/proc/}
    case "$keep" in *" $p "*) continue ;; esac
    [ "$(stat -c %u "$d" 2>/dev/null)" = "$me" ] || continue
    [ "$(field "$p" 4)" = "$init_session" ] && continue
    [ "$(field "$p" 3)" = "$own_group" ] && continue
    echo "$p"
  done
}
i=0
while [ "$i" -lt 50 ]; do
  left=$(found)
  [ -z "$left" ] && exit 0
  for p in $left; do kill -KILL "$p" 2>/dev/null; done
  sleep 0.1
  i=$((i + 1))
done
echo "processes left: $(found)" >&2
exit 1`

/** A free loopback port that the OS assigns. */
function osLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("Unsandboxed OpenCode listen port missing"))
        return
      }
      const allocated = address.port
      server.close((error) => (error ? reject(error) : resolve(allocated)))
    })
  })
}

const OPENCODE_READY_MARKER = "opencode server listening"
const OPENCODE_SERVE_ATTEMPTS = 3

/** Copy an output stream into memory so two readers can both see it. */
function teeOutput(source: AsyncIterable<string>) {
  const chunks: string[] = []
  let done = false
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) listener()
    listeners.clear()
  }
  const waitForChange = () =>
    new Promise<void>((resolve) => listeners.add(resolve))
  const finished = (async () => {
    try {
      for await (const chunk of source) {
        chunks.push(chunk)
        notify()
      }
    } catch {
      // A failed stream ends like a closed one.
    }
    done = true
    notify()
  })()
  return {
    finished,
    isDone: () => done,
    text: () => chunks.join(""),
    waitForChange,
    async *replay(): AsyncGenerator<string> {
      let index = 0
      for (;;) {
        while (index < chunks.length) yield chunks[index++] as string
        if (done) return
        await waitForChange()
      }
    },
  }
}

/**
 * A local `opencode serve` can exit because its port was taken between the
 * port pick and the bind. When it exits before it is ready and its output
 * says the address is in use, start it again on a fresh OS port, up to 3
 * attempts in all. Any other exit goes on unchanged: the caller reads the
 * output of the dead process and reports it.
 *
 * OpenCode 1.18.34 does not print EADDRINUSE. For a taken port it prints only
 * "Unexpected error" and "ServeError". It makes a ServeError only from the
 * error event of its server's listen call, and the local serve listens on
 * 127.0.0.1, so a ServeError is a taken port.
 */
export function withOpencodeServeRetry(
  provider: SandboxProvider,
  freePort: () => Promise<number> = osLoopbackPort,
): SandboxProvider {
  return wrapSandboxHandles(provider, (handle) => {
    const ports = new Map<number, number>()
    return {
      ...handle,
      ports: {
        ...handle.ports,
        connect: (port) => handle.ports.connect(ports.get(port) ?? port),
      },
      process: {
        ...handle.process,
        spawn: async (command, options) => {
          const requested = /^opencode serve .*--port=(\d+)/.exec(command)?.[1]
          if (!requested) return handle.process.spawn(command, options)
          let port = Number(requested)
          for (let attempt = 1; ; attempt++) {
            const proc = await handle.process.spawn(
              command.replace(`--port=${requested}`, `--port=${port}`),
              options,
            )
            const stdout = teeOutput(proc.stdout)
            const stderr = teeOutput(proc.stderr)
            while (
              !stdout.isDone() &&
              !stdout.text().includes(OPENCODE_READY_MARKER)
            )
              await stdout.waitForChange()
            if (!stdout.text().includes(OPENCODE_READY_MARKER))
              await Promise.all([stdout.finished, stderr.finished])
            const ready = stdout.text().includes(OPENCODE_READY_MARKER)
            const taken = /EADDRINUSE|address already in use|ServeError/i.test(
              `${stdout.text()}\n${stderr.text()}`,
            )
            if (!ready && taken && attempt < OPENCODE_SERVE_ATTEMPTS) {
              port = await freePort()
              continue
            }
            ports.set(Number(requested), port)
            return {
              pid: proc.pid,
              stdin: proc.stdin,
              stdout: stdout.replay(),
              stderr: stderr.replay(),
              wait: () => proc.wait(),
              kill: (signal) => proc.kill(signal),
            }
          }
        },
      },
    }
  })
}
