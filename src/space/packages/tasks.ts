import { runTarget, type RunContext, type RunResult } from "../scheduler/targets.ts";
import type { Task } from "../scheduler/types.ts";
import type { PackageRuntime } from "./runtime.ts";

/** Only the installation owner calls this; a remote catalogue never registers tasks. */
export async function runPackageTask(runtime: PackageRuntime, task: Task, ctx: RunContext): Promise<RunResult> {
  const installed = runtime.get(task.app);
  if (!installed) return { status: "error", error: "package is not activated" };
  const target = task.target;
  const localHttp = target.kind === "http" && target.url.startsWith("/");
  let lease: Awaited<ReturnType<PackageRuntime["acquire"]>> | undefined;
  try {
    lease = await runtime.acquire(task.app, localHttp);
    if (ctx.signal.aborted) return { status: "error", error: "timed out" };
    if (localHttp && (!lease.port || target.url.startsWith("//") || /[\\#\x00-\x20]/.test(target.url))) throw new Error("invalid package HTTP task path");
    return await runTarget(localHttp ? { ...target, url: `http://127.0.0.1:${lease.port}${target.url}` } : target, { ...ctx, appDir: installed.dir });
  } catch (e) { return { status: "error", error: (e as Error).message }; }
  finally { lease?.release(); }
}
