import { isOperator } from "../auth.ts";
import { DEFAULT_ARCHIVE_LIMIT } from "./archive.ts";
import type { PackageInstaller } from "./install.ts";

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;

/** Operator-only installation. Trust roots are host configuration, never supplied by an upload. */
export function createPackageRoutes(opts: { installer: PackageInstaller; token: string; trustedKeys?: string[] }): Record<string, Record<string, Handler>> {
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const denied = (req: Request) => !isOperator(req, opts.token);
  let uploads = 0;
  return {
    "/api/packages": {
      GET: (req) => denied(req) ? json({ ok: false, error: "unauthorized" }, 401) : json({ ok: true, spaceId: opts.installer.store.spaceId, operations: opts.installer.store.list() }),
      POST: async (req) => {
        if (denied(req)) return json({ ok: false, error: "unauthorized" }, 401);
        const length = Number(req.headers.get("content-length"));
        if (length > DEFAULT_ARCHIVE_LIMIT) return json({ ok: false, error: "package upload exceeds byte limit" }, 413);
        const type = req.headers.get("content-type")?.split(";", 1)[0];
        if (type !== "application/octet-stream") return json({ ok: false, error: "send the package as application/octet-stream" }, 415);
        if (uploads >= 2) return json({ ok: false, error: "package uploads are busy" }, 429);
        uploads++;
        try {
          if (!req.body) throw new Error("package body is required");
          const reader = req.body.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.length;
              if (total > DEFAULT_ARCHIVE_LIMIT) { await reader.cancel(); return json({ ok: false, error: "package upload exceeds byte limit" }, 413); }
              chunks.push(value);
            }
          } finally { reader.releaseLock(); }
          const operation = await opts.installer.install(Buffer.concat(chunks, total), {
            id: req.headers.get("idempotency-key") ?? undefined, trustedKeys: opts.trustedKeys,
            allowUnsigned: req.headers.get("x-space-allow-unsigned") === "true",
          });
          return json({ ok: operation.state !== "failed", operation }, operation.state === "failed" ? 409 : operation.state === "installing" ? 202 : 200);
        } catch (e) { return json({ ok: false, error: (e as Error).message }, 400); }
        finally { uploads--; }
      },
    },
    "/api/packages/operations/:id": {
      GET: (req) => {
        if (denied(req)) return json({ ok: false, error: "unauthorized" }, 401);
        const operation = opts.installer.store.get(req.params.id!);
        return operation ? json({ ok: true, operation }) : json({ ok: false, error: "operation not found" }, 404);
      },
    },
  };
}
