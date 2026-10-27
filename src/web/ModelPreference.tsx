import { useEffect, useRef, useState } from "react";
import { getJson, sendJson, type AgentInfo } from "./api.ts";
import { ChoiceOption, SavedChoice } from "./model-choices.tsx";
import { useLang } from "./i18n.ts";

type Preferences = { defaultModel: string | null; appDefault: string; baseDefault: string; options: NonNullable<AgentInfo["modelOptions"]> };

export default function ModelPreference({ onSaved }: { onSaved: () => void }) {
  const { t } = useLang();
  const [data, setData] = useState<Preferences | null>(null);
  const [error, setError] = useState("");
  // The choice being saved: shown at once, with the menu still usable, until the answer replaces it.
  const [choice, setChoice] = useState<string | null>(null);
  const saves = useRef(0);
  useEffect(() => {
    getJson<Preferences>("/api/model/preferences").then(setData).catch((e) => setError(e.message));
  }, []);
  const save = async (value: string) => {
    const n = ++saves.current;
    setChoice(value);
    setError("");
    try {
      const next = await sendJson<Preferences>("PUT", "/api/model/preferences", { defaultModel: value || null });
      if (n !== saves.current) return;
      setData(next);
      onSaved();
    } catch (e) {
      if (n === saves.current) setError((e as Error).message);
    } finally {
      if (n === saves.current) setChoice(null);
    }
  };
  return <>
    <label className="setrow">
      {t("settings.defaultModel")}
      <select className="setselect" disabled={!data} value={choice ?? data?.defaultModel ?? ""} onChange={(e) => void save(e.target.value)}>
        <option value="">{t("settings.modelEnvironment")}</option>
        {data?.defaultModel && !data.options.some((o) => o.value === data.defaultModel) && <SavedChoice value={data.defaultModel} t={t} />}
        {data?.options.map((o) => <ChoiceOption key={o.value} o={o} label={`${o.runtime} · ${t(`modelTier.${o.tier}`)} · ${o.model}`} t={t} />)}
      </select>
    </label>
    <p className="setnote">{t("settings.defaultModelHelp")}</p>
    {data && <p className="setnote">{t("settings.modelEffective", { apps: data.appDefault, base: data.baseDefault })}</p>}
    {error && <p className="setnote" role="alert">{error}</p>}
  </>;
}
