import { dlopen, FFIType } from "bun:ffi";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

/**
 * One Space service per workspace (docs/release.md#the-background-service). `start` takes an exclusive
 * `flock` (on Windows, a handle opened with no sharing) on `<workspace>/run/service.lock` for the life of the process; a second service on the
 * same workspace, from any launcher, finds it held and refuses to boot instead of
 * starting a second scheduler. The kernel drops the lock when the process ends, however it ends,
 * so a crash never leaves a stale lock. `run/service.json` says who holds it, for the message.
 */

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/** An exclusive hold on the lock file. `take` answers undefined when another holder has it. */
type Locker = { take(path: string, create: boolean): (() => void) | undefined };

let locker: Locker | undefined;

/** `flock` from libc; the kernel drops it with the descriptor. */
function posixLocker(): Locker {
  const name = process.platform === "darwin" ? "libc.dylib" : "libc.so.6";
  const { symbols } = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  return {
    take(path, create) {
      const fd = create ? openSync(path, "a+", 0o600) : openSync(path, "r");
      if (symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
        closeSync(fd);
        return undefined;
      }
      return () => {
        symbols.flock(fd, LOCK_UN);
        closeSync(fd);
      };
    },
  };
}

/**
 * Windows has no `flock`. A handle opened with no sharing makes the same promise: a second open of
 * the file fails while the handle lives, from any process, and the kernel closes the handle when
 * its process ends.
 */
function windowsLocker(): Locker {
  const GENERIC_READ_WRITE = 0xc0000000;
  const OPEN_EXISTING = 3;
  const OPEN_ALWAYS = 4;
  const FILE_ATTRIBUTE_NORMAL = 0x80;
  const { symbols } = dlopen("kernel32.dll", {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
  });
  return {
    take(path, create) {
      const wide = Buffer.from(`${path}${String.fromCharCode(0)}`, "utf16le");
      const handle = BigInt(symbols.CreateFileW(wide, GENERIC_READ_WRITE, 0, null, create ? OPEN_ALWAYS : OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null));
      // INVALID_HANDLE_VALUE: the file exists or may be created, so this is a sharing violation.
      if (handle === -1n) return undefined;
      return () => void symbols.CloseHandle(handle);
    },
  };
}

function lib(): Locker {
  return (locker ??= process.platform === "win32" ? windowsLocker() : posixLocker());
}

export type Holder = { pid: number; port?: number; edition?: string; version?: string; startedAt: string };

export class WorkspaceBusy extends Error {
  constructor(
    readonly workspace: string,
    readonly holder: Holder | undefined,
  ) {
    super(`another ai-space service already runs on ${workspace}${holder ? ` (pid ${holder.pid}${holder.port ? `, port ${holder.port}` : ""}, since ${holder.startedAt})` : ""}; stop it first, or point SPACE_HOME at another workspace`);
  }
}

export type WorkspaceLock = { release(): void; readonly path: string };

export const lockPath = (runDir: string) => join(runDir, "service.lock");
export const holderPath = (runDir: string) => join(runDir, "service.json");

/** Locks this process holds, kept on `globalThis` so `bun --hot` re-running `start` finds its own. */
const held = ((globalThis as { __spaceWorkspaceLocks?: Map<string, WorkspaceLock> }).__spaceWorkspaceLocks ??= new Map());

/** Takes the workspace's lock or throws `WorkspaceBusy`. Writes `run/service.json` once it holds it. */
export async function acquireWorkspaceLock(runDir: string, workspace: string, holder: Omit<Holder, "pid" | "startedAt">): Promise<WorkspaceLock> {
  mkdirSync(runDir, { recursive: true });
  const path = lockPath(runDir);
  const mine = held.get(path);
  if (mine) return mine;
  const drop = lib().take(path, true);
  if (!drop) throw new WorkspaceBusy(workspace, await readHolder(runDir));
  await Bun.write(holderPath(runDir), `${JSON.stringify({ pid: process.pid, ...holder, startedAt: new Date().toISOString() } satisfies Holder, null, 2)}\n`);
  let open = true;
  const lock: WorkspaceLock = {
    path,
    release() {
      if (!open) return;
      open = false;
      held.delete(path);
      drop();
    },
  };
  held.set(path, lock);
  return lock;
}

/** Whether a service holds the workspace's lock right now, without taking it. */
export function workspaceLocked(runDir: string): boolean {
  const path = lockPath(runDir);
  if (!existsSync(path)) return false;
  let drop: (() => void) | undefined;
  try {
    drop = lib().take(path, false);
  } catch {
    return false; // gone since the check, or unreadable: no holder this process can see
  }
  if (!drop) return true;
  drop();
  return false;
}

export async function readHolder(runDir: string): Promise<Holder | undefined> {
  try {
    return (await Bun.file(holderPath(runDir)).json()) as Holder;
  } catch {
    return undefined;
  }
}
