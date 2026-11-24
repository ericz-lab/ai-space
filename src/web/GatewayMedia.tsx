import { useCallback, useEffect, useState, type ReactNode } from "react";
import { getJson, sendJson, type GatewayInfo, type GatewayMediaProvider, type GatewaySpeechInfo, type SpeechChains, type SpeechChoice, type SpeechPlace } from "./api.ts";
import type { T } from "./MachineClis.tsx";

/**
 * Settings → Gateway's Speech and Image groups (docs/model-gateway.md#speech-group, #image-group).
 *
 * Speech: where the gateway's speech sits in providers.yaml for ASR and for TTS: off, after the
 * current default (the safe choice: the default keeps answering), or the default. Saving never
 * moves the default unless the owner picks "default". Live never goes through the gateway.
 * Image: the picture tier, which providers can draw and why others cannot, and a test picture.
 * Both tests run on click only and cost a little at the vendor.
 */

type Role = "asr" | "tts";
const ROLES: Role[] = ["asr", "tts"];

/** A chain as the page says it: the first answers, the rest are tried after it. */
function Chain({ chain, t }: { chain: string[]; t: T }) {
  if (!chain.length) return <span className="cli-dim">{t("speechg.none")}</span>;
  return (
    <span className="gw-chain">
      {chain.map((n, i) => (
        <span key={n}>
          {i > 0 && <span className="cli-dim"> → </span>}
          <b className={n.startsWith("gateway-") ? "gw-ours" : undefined}>{n}</b>
        </span>
      ))}
    </span>
  );
}

function Chains({ chains, label, t }: { chains: SpeechChains; label: string; t: T }) {
  return (
    <div className="gw-chains">
      <small className="cli-dim">{label}</small>
      <small>{t("speechg.asr")}: <Chain chain={chains.asr} t={t} /></small>
      <small>{t("speechg.tts")}: <Chain chain={chains.tts} t={t} /></small>
      <small>{t("speechg.live")}: <Chain chain={chains.live} t={t} /></small>
    </div>
  );
}

const can = (p: GatewayMediaProvider, role: Role | "image") => p.serves[role] === true && !p.off;

export function SpeechCard({ g, editable, onAddProvider, initial, t }: { g: GatewayInfo; editable: boolean; onAddProvider?: () => void; initial?: GatewaySpeechInfo; t: T }) {
  const [info, setInfo] = useState<GatewaySpeechInfo | null>(initial ?? null);
  const [draft, setDraft] = useState<SpeechChoice | null>(initial?.choice ?? null);
  const [after, setAfter] = useState<SpeechChains | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [clip, setClip] = useState<{ audio: string; type: string; ms: number } | null>(null);
  const [heard, setHeard] = useState("");
  const [testError, setTestError] = useState("");
  const [testing, setTesting] = useState<"" | Role>("");
  // Read again when the gateway's providers change (a provider added, a base set).
  const stamp = JSON.stringify(g.providers.map((p) => [p.name, p.openai, p.disabled, p.off, p.models]));
  const load = useCallback(() => {
    getJson<GatewaySpeechInfo>("/api/model/gateway/speech")
      .then((i) => {
        setInfo(i);
        setDraft(i.choice);
        setAfter(null);
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load, stamp]);
  const changed = Boolean(info && draft && JSON.stringify(draft) !== JSON.stringify(info.choice));
  const complete = Boolean(draft && ROLES.every((r) => draft[r].place === "off" || (draft[r].provider && draft[r].model)));
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
  const set = (role: Role, patch: Partial<SpeechChoice[Role]>) => {
    setStatus("");
    setError("");
    setDraft((d) => (d ? { ...d, [role]: { ...d[role], ...patch } } : d));
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
  const test = async (role: Role) => {
    const c = draft[role];
    setTesting(role);
    setTestError("");
    try {
      if (role === "tts") {
        setHeard("");
        const r = await sendJson<{ failed?: boolean; error?: string; audio?: string; contentType?: string; ms: number }>("POST", "/api/model/gateway/speech/test", { role, provider: c.provider, model: c.model, ...(draft.tts.voice ? { voice: draft.tts.voice } : {}) });
        if (r.failed || !r.audio) setTestError(r.error ?? "failed");
        else setClip({ audio: r.audio, type: r.contentType ?? "audio/wav", ms: r.ms });
      } else {
        const r = await sendJson<{ failed?: boolean; error?: string; text?: string; ms: number }>("POST", "/api/model/gateway/speech/test", { role, provider: c.provider, model: c.model, audio: clip?.audio });
        if (r.failed) setTestError(r.error ?? "failed");
        else setHeard(t("speechg.heard", { text: r.text ?? "", ms: r.ms }));
      }
    } catch (e) {
      setTestError((e as Error).message);
    } finally {
      setTesting("");
    }
  };
  const anyCan = (role: Role) => info.providers.some((p) => can(p, role));
  return (
    <div className="setcard gw">
      <p className="sethead">{t("speechg.title")}</p>
      <p className="setnote">{t("speechg.intro")}</p>
      <div className="gw-pad">
        <Chains chains={info.now} label={t("speechg.now")} t={t} />
        <small className="cli-dim gw-block">{t("speechg.liveNote")}</small>
        {info.readOnly && <p className="setnote err">{t("speechg.readOnly", { why: info.readOnly })}</p>}
        {info.problem && <p className="setnote err">{info.problem}</p>}
        {info.handWritten.length > 0 && <small className="cli-dim gw-block">{t("speechg.handWritten", { names: info.handWritten.join(", ") })}</small>}
        {ROLES.map((role) => {
          const c = draft[role];
          const offered = info.providers.filter((p) => can(p, role));
          const p = info.providers.find((x) => x.name === c.provider);
          const models = p ? (role === "asr" ? p.asrModels : p.ttsModels) : [];
          const voices = p && role === "tts" && c.model ? p.voices[c.model] ?? [] : [];
          const pick = (name: string) => {
            const q = info.providers.find((x) => x.name === name);
            const m = q ? (role === "asr" ? q.asrModels : q.ttsModels)[0] : undefined;
            set(role, { provider: name, model: m, ...(role === "tts" ? { voice: m && q ? q.voices[m]?.[0] : undefined } : {}) });
          };
          return (
            <fieldset key={role} className="gw-role">
              <legend>{t(role === "asr" ? "speechg.asrTitle" : "speechg.ttsTitle")}</legend>
              <div className="gw-places" role="radiogroup" aria-label={t(role === "asr" ? "speechg.asrTitle" : "speechg.ttsTitle")}>
                {(["off", "fallback", "default"] as SpeechPlace[]).map((place) => (
                  <label key={place} className="gw-check">
                    <input type="radio" name={`speech-${role}`} checked={c.place === place} disabled={lock || (place !== "off" && !anyCan(role))} onChange={() => (place !== "off" && !c.provider && offered[0] ? (set(role, { place }), pick(offered[0].name)) : set(role, { place }))} />
                    {t(`speechg.place.${place}`)}
                  </label>
                ))}
              </div>
              {c.place === "default" && <small className="gw-warn">{t("speechg.defaultWarn")}</small>}
              {!anyCan(role) && (
                <small className="cli-dim">
                  {t("speechg.nobody")} {onAddProvider && <button className="linkbtn" onClick={onAddProvider}>{t("gateway.addCan")}</button>}
                </small>
              )}
              {c.place !== "off" && (
                <>
                  <label className="gw-field">
                    <span>{t("speechg.provider")}</span>
                    <select className="setselect" value={c.provider ?? ""} disabled={lock} onChange={(e) => pick(e.target.value)}>
                      {!c.provider && <option value="" />}
                      {offered.map((x) => <option key={x.name} value={x.name}>{x.label === x.name ? x.name : `${x.name} · ${x.label}`}</option>)}
                    </select>
                  </label>
                  <label className="gw-field">
                    <span>{t("speechg.model")}</span>
                    {models.length ? (
                      <select className="setselect" value={c.model ?? ""} disabled={lock} onChange={(e) => set(role, { model: e.target.value, ...(role === "tts" ? { voice: p?.voices[e.target.value]?.[0] } : {}) })}>
                        {c.model && !models.includes(c.model) && <option value={c.model}>{c.model}</option>}
                        {models.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    ) : (
                      <input className="setselect" value={c.model ?? ""} spellCheck={false} autoCapitalize="off" placeholder={t("speechg.modelTyped")} disabled={lock} onChange={(e) => set(role, { model: e.target.value.trim() })} />
                    )}
                  </label>
                  {role === "tts" && (
                    <label className="gw-field">
                      <span>{t("speechg.voice")}</span>
                      {voices.length ? (
                        <select className="setselect" value={draft.tts.voice ?? ""} disabled={lock} onChange={(e) => set("tts", { voice: e.target.value })}>
                          {voices.map((v) => <option key={v} value={v}>{v}</option>)}
                        </select>
                      ) : (
                        <input className="setselect" value={draft.tts.voice ?? ""} spellCheck={false} autoCapitalize="off" placeholder={t("speechg.voiceTyped")} disabled={lock} onChange={(e) => set("tts", { voice: e.target.value.trim() })} />
                      )}
                    </label>
                  )}
                </>
              )}
            </fieldset>
          );
        })}
        {after && <Chains chains={after} label={t("speechg.after")} t={t} />}
        {editable && !info.readOnly && (
          <div className="setbtns">
            <span className="setbtns-gap" />
            <button className="btn2" disabled={busy || !changed} onClick={() => { setDraft(info.choice); setStatus(""); setError(""); }}>{t("common.cancel")}</button>
            <button className="btn2 primary" disabled={busy || !changed || !complete} onClick={() => void save()}>{t("magpie.save")}</button>
          </div>
        )}
        {status && <p className="setnote" role="status">{status}</p>}
        {error && <p className="setnote err" role="alert">{error}</p>}
        <div className="gw-tests-row">
          <button className="btn2" disabled={Boolean(testing) || draft.tts.place === "off" || !draft.tts.provider || !draft.tts.model} onClick={() => void test("tts")}>{testing === "tts" ? t("gateway.testing") : t("speechg.testTts")}</button>
          <button className="btn2" disabled={Boolean(testing) || !clip || draft.asr.place === "off" || !draft.asr.provider || !draft.asr.model} onClick={() => void test("asr")}>{testing === "asr" ? t("gateway.testing") : t("speechg.testAsr")}</button>
        </div>
        <small className="cli-dim gw-block">{t("speechg.testCost")}</small>
        {clip && (
          <div className="gw-clip">
            <audio controls src={`data:${clip.type};base64,${clip.audio}`} />
            <small className="cli-dim">{t("speechg.spoke", { ms: clip.ms })}</small>
          </div>
        )}
        {heard && <p className="setnote" role="status">{heard}</p>}
        {testError && <p className="setnote err" role="alert">{testError}</p>}
        <small className="cli-dim gw-block">{t("speechg.file", { file: info.file })}</small>
      </div>
    </div>
  );
}

export function ImageCard({ g, editable, busy, onAddProvider, onSave, t, children }: { g: GatewayInfo; editable: boolean; busy: boolean; onAddProvider?: () => void; onSave: (image: string) => void; t: T; children?: ReactNode }) {
  const [model, setModel] = useState(g.tiers.image ?? "");
  const [testing, setTesting] = useState(false);
  const [picture, setPicture] = useState<{ src: string; ms: number; served?: string } | null>(null);
  const [testError, setTestError] = useState("");
  useEffect(() => setModel(g.tiers.image ?? ""), [g.tiers.image]);
  const offered = g.imageModels.includes(model) || !model ? g.imageModels : [model, ...g.imageModels];
  const test = async () => {
    setTesting(true);
    setTestError("");
    setPicture(null);
    try {
      const r = await sendJson<{ failed?: boolean; error?: string; image?: string; type?: string; ms: number; served?: string }>("POST", "/api/model/gateway/image/test", model ? { model } : {});
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
              </li>
            ))}
          </ul>
        )}
        {g.imageModels.length === 0 && (
          <small className="cli-dim gw-block">
            {t("imageg.none")} {onAddProvider && <button className="linkbtn" onClick={onAddProvider}>{t("gateway.addCan")}</button>}
          </small>
        )}
        <label className="gw-field">
          <span>{t("gateway.imageTier")}</span>
          <select className="setselect" value={model} disabled={busy || !editable || (!offered.length && !model)} onChange={(e) => setModel(e.target.value)}>
            <option value="">{t("magpie.noTier")}</option>
            {offered.map((m) => <option key={m} value={m}>{g.groups[m] ? t("magpie.groupOption", { model: m }) : m}</option>)}
          </select>
        </label>
        {g.tiers.image && !g.imageModels.includes(g.tiers.image) && <small className="gw-warn gw-block">{t("imageg.stale")}</small>}
        {editable && (
          <div className="setbtns">
            <span className="setbtns-gap" />
            <button className="btn2 primary" disabled={busy || model === (g.tiers.image ?? "")} onClick={() => onSave(model)}>{t("magpie.save")}</button>
          </div>
        )}
        {children}
        <div className="gw-tests-row">
          <button className="btn2" disabled={testing || !model} onClick={() => void test()}>{testing ? t("gateway.testing") : t("imageg.test")}</button>
        </div>
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
