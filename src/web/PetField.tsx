import { useLang } from "./i18n.ts";
import { BUILTIN } from "./Pet.tsx";

/** The pet picker in the settings: a menu of the pets bundled with the panel (Pet.tsx `BUILTIN`). */
export default function PetField({ pet, onPet }: { pet: string; onPet: (name: string) => void }) {
  const { t } = useLang();
  return (
    <div className="setfield">
      <div className="setinput">
        <select aria-label={t("pet.kind")} value={pet} onChange={(e) => onPet(e.target.value)}>
          {Object.entries(BUILTIN).map(([name, p]) => (
            <option key={name} value={name}>
              {t(p.title)}
            </option>
          ))}
        </select>
      </div>
      {pet === "claude" && <p className="setnote">{t("pet.fromSpace")}</p>}
    </div>
  );
}
