import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Run on the operator's authenticated machine; never print API or signing keys. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

const account = required("CLOUDFLARE_ACCOUNT_ID");
const worker = required("OIDC_WORKER_NAME");
const issuer = required("OIDC_ISSUER");
const clientId = required("FEISHU_CLIENT_ID");
const redirect = required("FEISHU_REDIRECT_URI");
if (!/^[a-z0-9-]+$/.test(worker) || new URL(issuer).origin !== issuer || !issuer.startsWith("https://")) throw new Error("Invalid worker name or issuer");
if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/cdn-cgi\/access\/callback$/.test(redirect)) throw new Error("Expected an Access callback URL");
const bearer = process.env.CLOUDFLARE_API_TOKEN || String((await Bun.file(required("CF_AUTH_FILE")).json()).oauth_token ?? "");
if (!bearer) throw new Error("No Cloudflare credential");
const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}`;

async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  const form = body instanceof FormData;
  const response = await fetch(base + path, { method,
    headers: { Authorization: `Bearer ${bearer}`, ...(!form && body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: form ? body : body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json() as { success: boolean; result: unknown; errors?: { code: number; message: string }[] };
  if (!response.ok || !data.success) {
    // Cloudflare messages may echo input. Print error codes only.
    throw new Error(`Cloudflare ${method} ${path}: HTTP ${response.status}; codes ${data.errors?.map(e => e.code).join(",")}`);
  }
  return data.result;
}

async function privateFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
}

async function checkPublicKey(expectedKeyId?: string): Promise<void> {
  const response = await fetch(issuer + "/jwks", { signal: AbortSignal.timeout(15_000) });
  const data = await response.json() as { keys: (JsonWebKey & { kid: string })[] };
  const key = data.keys?.[0];
  if (!response.ok || !key || key.kty !== "RSA" || key.d || !key.kid || (expectedKeyId && key.kid !== expectedKeyId)) throw new Error("Public key verification failed");
  await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const rejected = await fetch(issuer + "/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code" }) });
  if (rejected.status !== 401) throw new Error("Unauthenticated request was not rejected");
}

const command = process.argv[2] ?? "deploy";
const scriptPath = `/workers/scripts/${worker}`;
function diagnostic(entry: any): Record<string, unknown> | undefined {
  if (entry?.event === "feishu_oidc_failure" && /^[a-z_]+$/.test(entry.stage)) return { stage: entry.stage };
  if (entry?.event === "feishu_oidc_upstream") return { upstreamStatus: Number(entry.status) || 0 };
  if (entry?.event === "feishu_oidc_identity") return {
    emailPresent: entry.emailPresent === true, emailFormatValid: entry.emailFormatValid === true,
    emailVerification: typeof entry.emailVerification === "boolean" ? entry.emailVerification : "unspecified",
    enterpriseEmailPresent: entry.enterpriseEmailPresent === true,
  };
  return undefined;
}
if (command === "deploy") {
  const keyPath = required("OIDC_KEY_FILE");
  let key: JsonWebKey;
  if (await Bun.file(keyPath).exists()) {
    key = await Bun.file(keyPath).json() as JsonWebKey;
    await chmod(keyPath, 0o600);
  } else {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    key = await crypto.subtle.exportKey("jwk", pair.privateKey);
    await privateFile(keyPath, key);
  }
  if (key.kty !== "RSA" || !key.n || !key.d) throw new Error("Invalid signing key");
  const keyId = new Bun.CryptoHasher("sha256").update(key.n).digest("hex").slice(0, 24);
  let source: string;
  if (process.env.OIDC_BUNDLE) source = await Bun.file(process.env.OIDC_BUNDLE).text();
  else {
    const build = await Bun.build({ entrypoints: [new URL("./worker.ts", import.meta.url).pathname], target: "browser", format: "esm", minify: true });
    if (!build.success || !build.outputs[0]) throw new Error("Worker build failed");
    source = await build.outputs[0].text();
  }
  const upload = new FormData();
  upload.set("metadata", new Blob([JSON.stringify({ main_module: "worker.js", compatibility_date: "2026-10-01",
    bindings: [
      { type: "plain_text", name: "ISSUER", text: issuer }, { type: "plain_text", name: "CLIENT_ID", text: clientId },
      { type: "plain_text", name: "REDIRECT_URI", text: redirect }, { type: "plain_text", name: "KEY_ID", text: keyId },
      { type: "secret_text", name: "SIGNING_JWK", text: JSON.stringify(key) },
    ], observability: { enabled: true, head_sampling_rate: 1, logs: { enabled: true, invocation_logs: false } },
  })], { type: "application/json" }));
  upload.set("worker.js", new Blob([source], { type: "application/javascript+module" }), "worker.js");
  const result = await api(scriptPath, "PUT", upload);
  await api(scriptPath + "/subdomain", "POST", { enabled: true, previews_enabled: false });
  console.log(JSON.stringify({ deployed: worker, version: result.version_id ?? result.id, issuer, keyId }));
  // DNS propagation can lag the upload. Run verify separately before activation.
} else if (command === "verify") {
  await checkPublicKey();
  console.log("Public key and anonymous-request checks passed");
} else if (command === "history") {
  const now = Date.now();
  const result = await api("/workers/observability/telemetry/query", "POST", {
    queryId: "feishu-login-diagnostics", timeframe: { from: now - 3_600_000, to: now }, view: "events", limit: 100,
    parameters: { datasets: ["cloudflare-workers"], filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: worker }] },
  });
  for (const event of result.events?.events ?? []) {
    const safe = diagnostic(event.source);
    if (safe) console.log(JSON.stringify({ at: new Date(event.timestamp).toISOString(), ...safe }));
  }
} else if (command === "logs") {
  const tail = await api(scriptPath + "/tails", "POST", {});
  const socket = new WebSocket(tail.url, ["trace-v1"]);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    socket.close();
    await api(scriptPath + "/tails/" + encodeURIComponent(tail.id), "DELETE");
    process.exit(0);
  };
  socket.onopen = () => console.log("Watching sanitized login diagnostics for 60 seconds");
  socket.onmessage = async message => {
    try {
      const event = JSON.parse(typeof message.data === "string" ? message.data : await new Response(message.data).text());
      const diagnostics = [];
      for (const log of event.logs ?? []) for (const value of log.message ?? []) {
        try {
          const safe = diagnostic(JSON.parse(value));
          if (safe) diagnostics.push(safe);
        } catch { /* Ignore any log that is not a known diagnostic. */ }
      }
      console.log(JSON.stringify({ at: new Date(event.eventTimestamp).toISOString(), status: event.event?.response?.status, diagnostics }));
    } catch { /* Do not print unknown tail payloads or request metadata. */ }
  };
  socket.onerror = () => console.error("Tail connection failed");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  setTimeout(stop, 60_000);
} else if (command === "activate" || command === "rollback") {
  const id = required("OIDC_PROVIDER_ID");
  const path = `/access/identity_providers/${encodeURIComponent(id)}`;
  const current = await api(path);
  if (current.type !== "oidc" || current.config.client_id !== clientId || current.config.redirect_url !== redirect) throw new Error("Provider identity does not match deployment");
  let next;
  if (command === "activate") {
    await checkPublicKey();
    // Save once; never overwrite the rollback snapshot on a repeat invocation.
    await privateFile(required("OIDC_BACKUP_FILE"), current);
    next = { ...current.config, auth_url: issuer + "/authorize", token_url: issuer + "/token", certs_url: issuer + "/jwks" };
  } else {
    const saved = await Bun.file(required("OIDC_BACKUP_FILE")).json();
    if (saved.id !== id || saved.config.client_id !== clientId) throw new Error("Rollback snapshot belongs to another provider");
    next = saved.config;
  }
  // Access retains its write-only client secret when this field is omitted.
  // Never replace it with an empty value or a placeholder from a GET response.
  delete next.client_secret;
  await api(path, "PUT", { name: current.name, type: current.type, config: next });
  const verified = await api(path);
  for (const key of ["auth_url", "token_url", "certs_url"]) {
    if (verified.config[key] !== next[key]) throw new Error(`Provider readback mismatch: ${key}`);
  }
  console.log(JSON.stringify({ action: command, provider: id, auth_url: verified.config.auth_url, token_url: verified.config.token_url, certs_url: verified.config.certs_url }));
} else throw new Error("Use deploy, verify, history, logs, activate or rollback");
