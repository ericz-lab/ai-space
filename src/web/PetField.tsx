import { useEffect, useState } from "react";
import { useLang } from "./i18n.ts";
import { type PetChoice, type PetdexPet, loadPetdex, resolvePet, suggestPets } from "./petdex.ts";

/**
 * The pet picker in the settings pop-over: type a name from petdex.dev, the sheet URL is looked up in
 * the public manifest and kept in the preferences. Empty means the bundled default.
 */
export default function PetField({ pet, onChange }: { pet: PetChoice | undefined; onChange: (p: PetChoice | undefined) => void }) {
  const { t } = useLang();
  const [query, setQuery] = useState(pet?.slug || "");
  const [pets, setPets] = useState<PetdexPet[] | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "error"; text: string }>({ kind: "idle" });
  useEffect(() => setQuery(pet?.slug || ""), [pet?.slug]);
  const warm = () => {
    if (pets) return;
    loadPetdex()
      .then(setPets)
      .catch(() => {});
  };
  const apply = () => {
    const q = query.trim();
    if (q === (pet?.slug || "")) return;
    if (!q) {
      setState({ kind: "idle" });
      return onChange(undefined);
    }
    setState({ kind: "busy" });
    resolvePet(q)
      .then((p) => {
        if (!p) return setState({ kind: "error", text: t("pet.notFound", { name: q }) });
        setState({ kind: "idle" });
        onChange(p);
      })
      .catch(() => setState({ kind: "error", text: t("pet.unreachable") }));
  };
  const note = state.kind === "busy" ? t("pet.lookingUp") : state.kind === "error" ? state.text : pet ? (pet.by ? t("pet.by", { name: pet.name, by: pet.by }) : pet.name) : t("pet.default");
  return (
    <div className="setfield">
      <div className="setinput">
        <input
          list="petdex-pets"
          placeholder={t("pet.placeholder")}
          value={query}
          spellCheck={false}
          autoComplete="off"
          onFocus={warm}
          onChange={(e) => {
            setQuery(e.target.value);
            warm();
          }}
          onBlur={apply}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        {/* Always in the DOM so the row keeps its width; hidden until there is something to clear. */}
        <button
          type="button"
          title={t("pet.reset")}
          style={{ visibility: pet || query ? "visible" : "hidden" }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setQuery("");
            setState({ kind: "idle" });
            onChange(undefined);
          }}
        >
          ×
        </button>
        <datalist id="petdex-pets">
          {suggestPets(pets || [], query).map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </datalist>
      </div>
      <p className={`setnote${state.kind === "error" ? " err" : ""}`}>{note}</p>
    </div>
  );
}
