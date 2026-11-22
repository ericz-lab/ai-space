/**
 * Pseudo-terminal wrapper for Windows, the counterpart of `pty_helper.py`: runs the command given
 * on the command line inside a new pseudoconsole (ConPTY, Windows 10 1809 and later) and speaks
 * the same protocol. stdin carries frames: one byte kind, four bytes big-endian length, payload.
 * Kind 0 is keystrokes, kind 1 is a resize (two big-endian uint16: cols, rows). stdout is the raw
 * terminal output. When stdin closes the pseudoconsole is closed, which ends what is attached to
 * it; a command still there two seconds later is terminated. The exit status is the command's
 * (129 when it was ended here).
 *
 * It is its own process, started by `pty.ts` with the server's Bun, so a mistake in the calls
 * below ends one terminal session and never the Space. The pseudoconsole's two ends are named
 * pipes: the system side is opened here through `kernel32`, the other side through `node:net`,
 * so reading and writing stay on Bun's event loop and nothing here blocks.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { connect, type Socket } from "node:net";

const { u32, u64, i32 } = FFIType;
const P = FFIType.ptr;

/** Opened when the helper runs: importing this file (a test reads `quoteArg`) must work on any system. */
const openKernel32 = () =>
  dlopen("kernel32.dll", {
    CreateNamedPipeW: { args: [P, u32, u32, u32, u32, u32, u32, P], returns: u64 },
    CreatePseudoConsole: { args: [u32, u64, u64, u32, P], returns: i32 },
    ResizePseudoConsole: { args: [u64, u32], returns: i32 },
    ClosePseudoConsole: { args: [u64], returns: FFIType.void },
    InitializeProcThreadAttributeList: { args: [P, u32, u32, P], returns: i32 },
    UpdateProcThreadAttribute: { args: [P, u32, u64, u64, u64, P, P], returns: i32 },
    CreateProcessW: { args: [P, P, P, P, i32, u32, P, P, P, P], returns: i32 },
    WaitForSingleObject: { args: [u64, u32], returns: u32 },
    GetExitCodeProcess: { args: [u64, P], returns: i32 },
    TerminateProcess: { args: [u64, u32], returns: i32 },
    CloseHandle: { args: [u64], returns: i32 },
    GetLastError: { args: [], returns: u32 },
  }).symbols;

let k32: ReturnType<typeof openKernel32>;

const INVALID_HANDLE = 0xffffffffffffffffn;
const PIPE_ACCESS_DUPLEX = 3; // `node:net` opens its end for reading and writing, whichever way the bytes go
const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
const PIPE_REJECT_REMOTE_CLIENTS = 8;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016n;
const STARTF_USESTDHANDLES = 0x100;
const KILL_GRACE_MS = 2_000;

const wide = (s: string) => Buffer.from(`${s}${String.fromCharCode(0)}`, "utf16le");
const clamp = (n: number) => Math.max(2, Math.min(500, Math.floor(Number(n) || 0) || 80));
/** A COORD passed by value: X in the low word, Y in the high word. */
const coord = (cols: number, rows: number) => ((clamp(rows) << 16) | clamp(cols)) >>> 0;

function fail(what: string): never {
  process.stderr.write(`conpty: ${what} (error ${k32.GetLastError()})\n`);
  process.exit(127);
}

/** One argument as `CommandLineToArgvW` reads it back. */
export function quoteArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
    } else if (ch === '"') {
      out += "\\".repeat(slashes * 2 + 1) + '"';
      slashes = 0;
    } else {
      out += "\\".repeat(slashes) + ch;
      slashes = 0;
    }
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

async function main(cmd: string[]): Promise<void> {
  if (!cmd.length) {
    process.stderr.write("usage: conpty_helper.ts <command> [args...]\n");
    process.exit(2);
  }
  k32 = openKernel32();
  const cols = clamp(Number(process.env.PTY_COLS));
  const rows = clamp(Number(process.env.PTY_ROWS) || 24);

  // The pseudoconsole reads keystrokes from one pipe and writes the screen to the other.
  const base = `\\\\.\\pipe\\space-conpty-${process.pid}-${crypto.randomUUID()}`;
  const pipe = (name: string, access: number) => {
    const h = BigInt(k32.CreateNamedPipeW(wide(name), access | FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_REJECT_REMOTE_CLIENTS, 1, 1 << 20, 1 << 20, 0, null));
    if (h === INVALID_HANDLE) fail(`could not make ${name}`);
    return h;
  };
  const inServer = pipe(`${base}-in`, PIPE_ACCESS_DUPLEX);
  const outServer = pipe(`${base}-out`, PIPE_ACCESS_DUPLEX);
  const open = (name: string) =>
    new Promise<Socket>((resolve, reject) => {
      const s = connect(name);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  const [keys, screen] = await Promise.all([open(`${base}-in`), open(`${base}-out`)]).catch((e: Error) => fail(`could not open the pipes: ${e.message}`));

  const hpcOut = new BigUint64Array(1);
  const hr = k32.CreatePseudoConsole(coord(cols, rows), inServer, outServer, 0, hpcOut);
  if (hr !== 0) fail(`CreatePseudoConsole answered 0x${(hr >>> 0).toString(16)}`);
  const hpc = hpcOut[0]!;

  // STARTUPINFOEXW with one attribute: the pseudoconsole the command is attached to.
  const size = new BigUint64Array(1);
  k32.InitializeProcThreadAttributeList(null, 1, 0, size);
  const attributes = Buffer.alloc(Number(size[0]));
  if (!k32.InitializeProcThreadAttributeList(attributes, 1, 0, size)) fail("InitializeProcThreadAttributeList");
  if (!k32.UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpc, 8n, null, null)) fail("UpdateProcThreadAttribute");
  const startup = Buffer.alloc(112);
  startup.writeUInt32LE(112, 0);
  // No standard handles of this process: they are pipes to the server, not the terminal.
  startup.writeUInt32LE(STARTF_USESTDHANDLES, 60);
  startup.writeBigUInt64LE(BigInt(ptr(attributes)), 104);
  const info = Buffer.alloc(24);
  const line = wide(cmd.map(quoteArg).join(" "));
  if (!k32.CreateProcessW(null, line, null, null, 0, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, null, null, startup, info)) {
    const code = k32.GetLastError();
    k32.ClosePseudoConsole(hpc);
    process.stderr.write(`conpty: could not start ${cmd[0]} (error ${code})\n`);
    process.exit(127);
  }
  const child = info.readBigUInt64LE(0);
  k32.CloseHandle(info.readBigUInt64LE(8));

  screen.on("data", (chunk: Buffer) => void process.stdout.write(chunk));
  screen.on("error", () => {});
  keys.on("error", () => {});

  let closed = false;
  const closeConsole = () => {
    if (closed) return;
    closed = true;
    k32.ClosePseudoConsole(hpc);
  };

  let ended = false;
  const finish = (code: number) => {
    if (ended) return;
    ended = true;
    // The screen's last bytes are still in the pipe: closing the pseudoconsole flushes them.
    closeConsole();
    setTimeout(() => {
      keys.destroy();
      screen.destroy();
      k32.CloseHandle(child);
      k32.CloseHandle(inServer);
      k32.CloseHandle(outServer);
      process.exit(code);
    }, 60);
  };

  let hungUp = false;
  const exitCode = new Uint32Array(1);
  const watch = setInterval(() => {
    if (k32.WaitForSingleObject(child, 0) !== 0) return;
    clearInterval(watch);
    k32.GetExitCodeProcess(child, exitCode);
    finish(hungUp ? 129 : exitCode[0]! & 0xff);
  }, 50);

  const hangUp = () => {
    if (hungUp) return;
    hungUp = true;
    closeConsole(); // ends what is attached to the pseudoconsole
    setTimeout(() => {
      if (!ended) k32.TerminateProcess(child, 1);
    }, KILL_GRACE_MS);
  };

  // Frames from the server.
  let pending: Buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 5) {
      const length = pending.readUInt32BE(1);
      if (pending.length < 5 + length) break;
      const kind = pending[0];
      const payload = pending.subarray(5, 5 + length);
      pending = pending.subarray(5 + length);
      if (kind === 0 && !closed) keys.write(Buffer.from(payload));
      else if (kind === 1 && length >= 4 && !closed) k32.ResizePseudoConsole(hpc, coord(payload.readUInt16BE(0), payload.readUInt16BE(2)));
    }
  });
  process.stdin.on("end", hangUp);
  process.stdin.on("close", hangUp);
}

if (import.meta.main) await main(process.argv.slice(2));
