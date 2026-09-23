import { useEffect, useState } from "react";
import { getJson, sendJson, type AgentInfo } from "./api.ts";
import { useLang } from "./i18n.ts";

type Preferences = { defaultModel: string | null; appDefault: string; baseDefault: string; options: NonNullable<AgentInfo["modelOptions"]> };

export default function ModelPreference({ onSaved }: { onSaved: () => void }) {
  const { t } = useLang();
  const [data, setData] = useState<Preferences | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    getJson<Preferences>("/api/model/preferences").then(setData).catch((e) => setError(e.message));
  }, []);
  const save = async (value: string) => {
    setSaving(true);
    setError("");
    try {
      setData(await sendJson<Preferences>("PUT", "/api/model/preferences", { defaultModel: value || null }));
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return <>
    <label className="setrow">
      {t("settings.defaultModel")}
      <select className="setselect" disabled={!data || saving} value={data?.defaultModel ?? ""} onChange={(e) => void save(e.target.value)}>
        <option value="">{t("settings.modelEnvironment")}</option>
        {data?.defaultModel && !data.options.some((o) => o.value === data.defaultModel) && <option value={data.defaultModel}>{data.defaultModel}</option>}
        {data?.options.map((o) => <option key={o.value} value={o.value}>{o.runtime} · {t(`modelTier.${o.tier}`)} · {o.model}</option>)}
      </select>
    </label>
    <p className="setnote">{t("settings.defaultModelHelp")}</p>
    {data && <p className="setnote">{t("settings.modelEffective", { apps: data.appDefault, base: data.baseDefault })}</p>}
    {error && <p className="setnote" role="alert">{error}</p>}
  </>;
}
