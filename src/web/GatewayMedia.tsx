import { useCallback, useEffect, useState, type ReactNode } from "react";
import { getJson, sendJson, type GatewayInfo, type GatewayMediaProvider, type GatewaySpeechInfo, type SpeechChainItem, type SpeechChains, type SpeechCustomProvider, type SpeechOrder } from "./api.ts";
import type { T } from "./MachineClis.tsx";

/**
 * Settings → Gateway's Speech and Image groups (docs/model-gateway.md#speech-group, #image-group).
 *
 * Speech: every speech provider in one list, the gateway's that can and the space's own from
 * providers.yaml (custom), and for ASR and for TTS an order: the first answers, the rest are tried
 * after it. Nothing here names a provider the space does not have: the names come from the server's
 * view, which lists the built-in default's provider only when it is really there. Live is shown,
 * read-only, when a provider can do it; it never goes through the gateway.
 * Image: the picture tier, which providers can draw and why others cannot, and a test picture.
 * Every test runs on click only and costs a little at the vendor.
 */

type Role = "asr" | "tts";
const ROLES: Role[] = ["asr", "tts"];

const keyOf = (i: SpeechChainItem) => ("gateway" in i ? `g:${i.gateway}` : `p:${i.provider}`);
const canGw = (p: GatewayMediaProvider, role: Role | "image") => p.serves[role] === true && !p.off;
const modelsOf = (p: GatewayMediaProvider, role: Role) => (role === "asr" ? p.asrModels : p.ttsModels);

/** A gateway provider as an order item: its first model of the kind, and for TTS its first documented voice. */
function gatewayItem(p: GatewayMediaProvider, role: Role): SpeechChainItem {
  const model = modelsOf(p, role)[0] ?? "";
  const voice = role === "tts" ? p.voices[model]?.[0] : undefined;
  return { gateway: p.name, model, ...(voice ? { voice } : {}) };
}

/** Where a custom provider is, in the page's words. */
function whereOf(c: SpeechCustomProvider, t: T): string | undefined {
  if (c.located === false) return t("speechg.notFound");
  if (c.machine === undefined) return undefined;
  return c.machine ? t("speechg.onMachine", { machine: c.machine }) : t("speechg.here");
}

function ServesChips({ serves, t }: { serves: { asr: boolean; tts: boolean; live?: boolean }; t: T }) {
  return (
    <>
      {(["asr", "tts", "live"] as const).filter((k) => serves[k] !== undefined).map((k) => (
        <span key={k} className={`gw-chip ${serves[k] ? "on" : "no"}`}>{serves[k] ? "✓" : "✕"} {t(`speechg.${k}`)}</span>
      ))}
    </>
  );
}

export function SpeechCard({ g, editable, onAddProvider, initial, t }: { g: GatewayInfo; editable: boolean; onAddProvider?: () => void; initial?: GatewaySpeechInfo; t: T }) {
  const [info, setInfo] = useState<GatewaySpeechInfo | null>(initial ?? null);
  const [draft, setDraft] = useState<SpeechOrder | null>(initial?.order ?? null);
  const [after, setAfter] = useState<SpeechChains | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [clip, setClip] = useState<{ audio: string; type: string; ms: number; by: string } | null>(null);
  const [heard, setHeard] = useState("");
  const [testError, setTestError] = useState("");
  const [testing, setTesting] = useState("");
  // Read again when the gateway's providers change (a provider added, a base set).
  const stamp = JSON.stringify(g.providers.map((p) => [p.name, p.openai, p.disabled, p.off, p.models, p.kinds]));
  const load = useCallback(() => {
    getJson<GatewaySpeechInfo>("/api/model/gateway/speech")
      .then((i) => {
        setInfo(i);
        setDraft(i.order);
        setAfter(null);
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => {
    if (!initial) load();
  }, [load, stamp]);
  const changed = Boolean(info && draft && JSON.stringify(draft) !== JSON.stringify(info.order));
  const complete = Boolean(draft && ROLES.every((r) => draft[r].every((i) => !("gateway" in i) || i.model)));
  // What saving would give, asked of the server (the same planner that writes the file).
  useEffect(() => {
    if (!changed || !complete || !draft) {
      setAfter(null);
      return;
    }
    let stale = false;
    const id = setTimeout(() => {
      sendJson<{ after: SpeechChains }>("PUT", "/api/model/gateway/speech", { ...draft, dryRun: true })
        .then((r) => !stale && setAfter(r.after))
        .catch((e) => !stale && setError((e as Error).message));
    }, 250);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [changed, complete, JSON.stringify(draft)]);
  if (!info || !draft) return <div className="setcard gw"><p className="sethead">{t("speechg.title")}</p><p className="setnote">{error || t("common.loading")}</p></div>;
  const lock = !editable || Boolean(info.readOnly) || busy;
  const speechGw = info.providers.filter((p) => canGw(p, "asr") || canGw(p, "tts"));
  const gwOf = (name: string) => info.providers.find((p) => p.name === name);
  const customOf = (name: string) => info.custom.find((c) => c.name === name);
  const nameOf = (i: SpeechChainItem) => ("gateway" in i ? i.gateway : i.provider);
  const setRole = (role: Role, list: SpeechChainItem[]) => {
    setStatus("");
    setError("");
    setDraft((d) => (d ? { ...d, [role]: list } : d));
  };
  const move = (role: Role, i: number, by: number) => {
    const list = [...draft[role]];
    const [x] = list.splice(i, 1);
    list.splice(i + by, 0, x!);
    setRole(role, list);
  };
  const patch = (role: Role, i: number, p: Partial<{ model: string; voice: string }>) => setRole(role, draft[role].map((x, j) => (j === i && "gateway" in x ? { ...x, ...p } : x)));
  // What can join an order: custom providers that can take the role, gateway providers that can.
  const addable = (role: Role) => {
    const taken = new Set(draft[role].map(keyOf));
    return [
      ...info.custom.filter((c) => c.serves[role] && !taken.has(`p:${c.name}`)).map((c) => ({ key: `p:${c.name}`, label: `${c.name} · ${t("speechg.custom")}`, item: { provider: c.name } as SpeechChainItem })),
      ...info.providers.filter((p) => canGw(p, role) && !taken.has(`g:${p.name}`)).map((p) => ({ key: `g:${p.name}`, label: `${p.name} · ${p.label} · ${t("speechg.viaGateway")}`, item: gatewayItem(p, role) })),
    ];
  };
  const save = async () => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const r = await sendJson<{ applied: boolean; restart?: boolean }>("PUT", "/api/model/gateway/speech", draft);
      setStatus(t(r.applied ? "speechg.saved" : "speechg.savedRestart"));
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  /** A test of one provider: its TTS speaks, its ASR transcribes the last clip. */
  const test = async (role: Role, target: { speech: string } | { gateway: string }) => {
    const id = `${role}:${"speech" in target ? target.speech : target.gateway}`;
    setTesting(id);
    setTestError("");
    try {
      let body: Record<string, unknown> = { role, ...target };
      if ("gateway" in target) {
        const p = gwOf(target.gateway)!;
        const inOrder = draft[role].find((x) => "gateway" in x && x.gateway === target.gateway) as { model: string; voice?: string } | undefined;
        const model = inOrder?.model ?? modelsOf(p, role)[0];
        const voice = role === "tts" ? inOrder?.voice ?? p.voices[model ?? ""]?.[0] : undefined;
        body = { role, provider: p.name, model, ...(voice ? { voice } : {}) };
      }
      if (role === "tts") {
        setHeard("");
        const r = await sendJson<{ failed?: boolean; error?: string; audio?: string; contentType?: string; ms: number }>("POST", "/api/model/gateway/speech/test", body);
        if (r.failed || !r.audio) setTestError(r.error ?? "failed");
        else setClip({ audio: r.audio, type: r.contentType ?? "audio/wav", ms: r.ms, by: "speech" in target ? target.speech : target.gateway });
      } else {
        const r = await sendJson<{ failed?: boolean; error?: string; text?: string; ms: number }>("POST", "/api/model/gateway/speech/test", { ...body, audio: clip?.audio });
        if (r.failed) setTestError(r.error ?? "failed");
        else setHeard(t("speechg.heard", { text: r.text ?? "", ms: r.ms }));
      }
    } catch (e) {
      setTestError((e as Error).message);
    } finally {
      setTesting("");
    }
  };
  const testButtons = (serves: { asr: boolean; tts: boolean }, target: { speech: string } | { gateway: string }) => {
    const name = "speech" in target ? target.speech : target.gateway;
    return (
      <span className="gw-row-tests">
        {serves.tts && <button className="btn2" disabled={Boolean(testing)} onClick={() => void test("tts", target)}>{testing === `tts:${name}` ? t("gateway.testing") : t("speechg.testTts")}</button>}
        {serves.asr && <button className="btn2" disabled={Boolean(testing) || !clip} title={clip ? undefined : t("speechg.needClip")} onClick={() => void test("asr", target)}>{testing === `asr:${name}` ? t("gateway.testing") : t("speechg.testAsr")}</button>}
      </span>
    );
  };
  const nothing = info.custom.length === 0 && speechGw.length === 0;
  return (
    <div className="setcard gw">
      <p className="sethead">{t("speechg.title")}</p>
      <p className="setnote">{t("speechg.intro")}</p>
      <div className="gw-pad">
        {info.readOnly && <p className="setnote err">{t("speechg.readOnly", { why: info.readOnly })}</p>}
        {info.problem && <p className="setnote err">{info.problem}</p>}
        {nothing ? (
          <p className="setnote">
            {t("speechg.nothing")} {onAddProvider && <button className="linkbtn" onClick={onAddProvider}>{t("gateway.addCan")}</button>}
          </p>
        ) : (
          <ul className="gw-speech-list">
            {info.custom.map((c) => (
              <li key={`p:${c.name}`}>
                <span className="gw-row-head">
                  <b>{c.name}</b>
                  <span className="gw-chip">{t("speechg.custom")}</span>
                  <ServesChips serves={c.serves} t={t} />
                </span>
                {(whereOf(c, t) || c.off) && <small className={c.located === false || c.off ? "gw-warn" : "cli-dim"}>{[whereOf(c, t), c.off].filter(Boolean).join(" · ")}</small>}
                {c.testable && testButtons(c.serves, { speech: c.name })}
              </li>
            ))}
            {speechGw.map((p) => (
              <li key={`g:${p.name}`}>
                <span className="gw-row-head">
                  <b>{p.name}</b>
                  {p.label !== p.name && <small className="cli-dim">{p.label}</small>}
                  <span className="gw-chip kind-asr">{t("speechg.viaGateway")}</span>
                  <ServesChips serves={{ asr: canGw(p, "asr"), tts: canGw(p, "tts") }} t={t} />
                </span>
                {testButtons({ asr: canGw(p, "asr"), tts: canGw(p, "tts") }, { gateway: p.name })}
              </li>
            ))}
          </ul>
        )}
        {!nothing && onAddProvider && <small className="cli-dim gw-block"><button className="linkbtn" onClick={onAddProvider}>{t("gateway.addCan")}</button></small>}
        {ROLES.map((role) => {
          const list = draft[role];
          const more = addable(role);
          return (
            <fieldset key={role} className="gw-role">
              <legend>{t(role === "asr" ? "speechg.asrTitle" : "speechg.ttsTitle")}</legend>
              {list.length === 0 ? (
                <small className="cli-dim">{t("speechg.empty")}</small>
              ) : (
                <ol className="gw-order-list">
                  {list.map((item, i) => {
                    const p = "gateway" in item ? gwOf(item.gateway) : undefined;
                    const c = "gateway" in item ? undefined : customOf(item.provider);
                    const models = p ? modelsOf(p, role) : [];
                    const voices = p && "gateway" in item && role === "tts" ? p.voices[item.model] ?? [] : [];
                    return (
                      <li key={keyOf(item)} className={"gateway" in item && p ? "gw-order-item has-fields" : "gw-order-item"}>
                        <div className="gw-order-head">
                          <span>
                            <b>{nameOf(item)}</b> <small className="cli-dim">{i === 0 ? t("speechg.first") : t("speechg.then")}{"gateway" in item ? ` · ${t("speechg.viaGateway")}` : c ? ` · ${t("speechg.custom")}` : ""}</small>
                          </span>
                          {!lock && (
                            <span className="gw-order">
                              <button className="btn2" aria-label={t("gateway.up1")} disabled={i === 0} onClick={() => move(role, i, -1)}>↑</button>
                              <button className="btn2" aria-label={t("gateway.down1")} disabled={i === list.length - 1} onClick={() => move(role, i, 1)}>↓</button>
                              <button className="btn2" aria-label={t("speechg.takeOut", { name: nameOf(item) })} onClick={() => setRole(role, list.filter((_, j) => j !== i))}>✕</button>
                            </span>
                          )}
                        </div>
                        {"gateway" in item && !p && <small className="gw-warn">{t("speechg.gone")}</small>}
                        {"gateway" in item && p && (
                          // Inside this provider's own box: its model and voice, not the role's.
                          <div className="gw-order-fields">
                            <label className="gw-field">
                              <span>{t("speechg.model")}</span>
                              {models.length ? (
                                <select className="setselect" value={item.model} disabled={lock} onChange={(e) => patch(role, i, { model: e.target.value, ...(role === "tts" ? { voice: p.voices[e.target.value]?.[0] ?? "" } : {}) })}>
                                  {!models.includes(item.model) && <option value={item.model}>{item.model}</option>}
                                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                                </select>
                              ) : (
                                <input className="setselect" value={item.model} spellCheck={false} autoCapitalize="off" placeholder={t("speechg.modelTyped")} disabled={lock} onChange={(e) => patch(role, i, { model: e.target.value.trim() })} />
                              )}
                            </label>
                            {role === "tts" && (
                              <label className="gw-field">
                                <span>{t("speechg.voice")}</span>
                                {voices.length && p.voicesOpen ? (
                                  // The vendor's documented voices to pick from, and any other voice id it has (a cloned one) typed.
                                  <>
                                    <input className="setselect" list={`gw-voices-${p.name}`} value={item.voice ?? ""} spellCheck={false} autoCapitalize="off" placeholder={t("speechg.voiceTyped")} disabled={lock} onChange={(e) => patch(role, i, { voice: e.target.value })} />
                                    <datalist id={`gw-voices-${p.name}`}>{voices.map((v) => <option key={v} value={v} />)}</datalist>
                                  </>
                                ) : voices.length ? (
                                  <select className="setselect" value={item.voice ?? ""} disabled={lock} onChange={(e) => patch(role, i, { voice: e.target.value })}>
                                    {voices.map((v) => <option key={v} value={v}>{v}</option>)}
                                  </select>
                                ) : (
                                  <input className="setselect" value={item.voice ?? ""} spellCheck={false} autoCapitalize="off" placeholder={t("speechg.voiceTyped")} disabled={lock} onChange={(e) => patch(role, i, { voice: e.target.value.trim() })} />
                                )}
                              </label>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
              {!lock && more.length > 0 && (
                <select className="setselect" value="" aria-label={t("speechg.add")} onChange={(e) => { const m = more.find((x) => x.key === e.target.value); if (m) setRole(role, [...list, m.item]); }}>
                  <option value="">{t("speechg.add")}</option>
                  {more.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              )}
            </fieldset>
          );
        })}
        {info.live && (
          <small className="cli-dim gw-block">
            {t("speechg.live")}: {info.live.length ? info.live.join(" → ") : t("speechg.none")} · {t("speechg.liveNote")}
          </small>
        )}
        {after && (
          <div className="gw-chains">
            <small className="cli-dim">{t("speechg.after")}</small>
            <small>{t("speechg.asr")}: {after.asr.join(" → ") || t("speechg.none")}</small>
            <small>{t("speechg.tts")}: {after.tts.join(" → ") || t("speechg.none")}</small>
          </div>
        )}
        {editable && !info.readOnly && (
          <div className="setbtns">
            <span className="setbtns-gap" />
            <button className="btn2" disabled={busy || !changed} onClick={() => { setDraft(info.order); setStatus(""); setError(""); }}>{t("common.cancel")}</button>
            <button className="btn2 primary" disabled={busy || !changed || !complete} onClick={() => void save()}>{t("magpie.save")}</button>
          </div>
        )}
        {status && <p className="setnote" role="status">{status}</p>}
        {error && <p className="setnote err" role="alert">{error}</p>}
        {!nothing && <small className="cli-dim gw-block">{t("speechg.testCost")}</small>}
        {clip && (
          <div className="gw-clip">
            <audio controls src={`data:${clip.type};base64,${clip.audio}`} />
            <small className="cli-dim">{t("speechg.spoke", { ms: clip.ms, name: clip.by })}</small>
          </div>
        )}
        {heard && <p className="setnote" role="status">{heard}</p>}
        {testError && <p className="setnote err" role="alert">{testError}</p>}
        {info.exists && <small className="cli-dim gw-block">{t("speechg.file", { file: info.file })}</small>}
      </div>
    </div>
  );
}

/**
 * A picture model for a provider that can draw: the ids its vendor documents, one click each, or an
 * id typed by hand (Ark's pay-as-you-go ids are dated and differ by account).
 */
function AddImageModel({ offered, taken, busy, onAdd, t }: { offered: string[]; taken: string[]; busy: boolean; onAdd: (model: string) => void; t: T }) {
  const [id, setId] = useState("");
  const typed = id.trim();
  return (
    <div className="gw-addmodel">
      {offered.map((m) => (
        <button key={m} type="button" className="btn2" disabled={busy} onClick={() => onAdd(m)}>{t("imageg.addOffered", { model: m })}</button>
      ))}
      <input className="setinput" value={id} placeholder={t("imageg.addPlaceholder")} aria-label={t("imageg.addPlaceholder")} disabled={busy} onChange={(e) => setId(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && typed && !taken.includes(typed)) { onAdd(typed); setId(""); } }} />
      <button type="button" className="btn2" disabled={busy || !typed || taken.includes(typed)} onClick={() => { onAdd(typed); setId(""); }}>{t("imageg.add")}</button>
    </div>
  );
}

/**
 * The Pictures group: which providers can draw, their picture models (and adding one), and a test
 * picture from the model picked here. There is no picture tier: an app's picture call names its
 * model (docs/model.md#models), so the select only says which model the test draws with.
 */
export function ImageCard({ g, editable, busy, onAddProvider, onAddModel, t, children }: { g: GatewayInfo; editable: boolean; busy: boolean; onAddProvider?: () => void; onAddModel?: (provider: GatewayInfo["providers"][number], model: string) => void; t: T; children?: ReactNode }) {
  const [model, setModel] = useState(g.imageModels[0] ?? "");
  const [testing, setTesting] = useState(false);
  const [picture, setPicture] = useState<{ src: string; ms: number; served?: string } | null>(null);
  const [testError, setTestError] = useState("");
  // A model added or removed: keep the pick when it is still there.
  useEffect(() => setModel((m) => (g.imageModels.includes(m) ? m : (g.imageModels[0] ?? ""))), [g.imageModels.join(",")]);
  const test = async () => {
    setTesting(true);
    setTestError("");
    setPicture(null);
    try {
      const r = await sendJson<{ failed?: boolean; error?: string; image?: string; type?: string; ms: number; served?: string }>("POST", "/api/model/gateway/image/test", { model });
      if (r.failed || !r.image) setTestError(r.error ?? "failed");
      else setPicture({ src: `data:${r.type};base64,${r.image}`, ms: r.ms, ...(r.served ? { served: r.served } : {}) });
    } catch (e) {
      setTestError((e as Error).message);
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="setcard gw">
      <p className="sethead">{t("imageg.title")}</p>
      <p className="setnote">{t("imageg.intro")}</p>
      <div className="gw-pad">
        {g.providers.length > 0 && (
          <ul className="gw-who">
            {g.providers.map((p) => (
              <li key={p.name} className={p.serves?.image === true ? "ok" : ""}>
                <b>{p.name}</b> {p.serves?.image === true ? t("imageg.can", { n: p.models.filter((m) => p.kinds?.[m] === "image").length }) : <span className="cli-dim">{String(p.serves?.image ?? "")}</span>}
                {editable && onAddModel && p.serves?.image === true && <AddImageModel offered={p.imageOffer ?? []} taken={p.models} busy={busy} onAdd={(m) => onAddModel(p, m)} t={t} />}
              </li>
            ))}
          </ul>
        )}
        {g.imageModels.length === 0 && (
          <small className="cli-dim gw-block">
            {t("imageg.none")} {onAddProvider && <button className="linkbtn" onClick={onAddProvider}>{t("gateway.addCan")}</button>}
          </small>
        )}
        {/* gateway.yaml from before: its picture tier loads and nothing reads it. */}
        {g.tiers.image && <small className="gw-warn gw-block">{t("imageg.tierIgnored", { model: g.tiers.image })}</small>}
        {children}
        {g.imageModels.length > 0 && (
          <div className="gw-tests-row">
            <label className="gw-field">
              <span>{t("imageg.testModel")}</span>
              <select className="setselect" value={model} disabled={testing} onChange={(e) => setModel(e.target.value)}>
                {g.imageModels.map((m) => <option key={m} value={m}>{g.groups[m] ? t("magpie.groupOption", { model: m }) : m}</option>)}
              </select>
            </label>
            <button className="btn2" disabled={testing || !model} onClick={() => void test()}>{testing ? t("gateway.testing") : t("imageg.test")}</button>
          </div>
        )}
        <small className="cli-dim gw-block">{t("imageg.testCost")}</small>
        {picture && (
          <div className="gw-clip">
            <img className="gw-picture" src={picture.src} alt={t("imageg.alt")} />
            <small className="cli-dim">{t("imageg.made", { ms: picture.ms, model: picture.served ?? model })}</small>
          </div>
        )}
        {testError && <p className="setnote err" role="alert">{testError}</p>}
        <small className="cli-dim gw-block">{t("imageg.urlRule")}</small>
      </div>
    </div>
  );
}
