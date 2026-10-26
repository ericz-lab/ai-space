import type { ModelChoice } from "./api.ts";
import type { Key } from "./messages.ts";

/**
 * How every model picker shows a choice (docs/model-machines.md#inventory): the server already
 * left out what is missing on its machine; one that is not signed in, or on a peer that is
 * offline, comes with `unavailable` and is shown greyed; a saved choice that is no longer offered
 * stays selected, marked, so nothing is rewritten behind the person's back.
 */

type T = (key: Key, vars?: Record<string, string | number>) => string;

const reasonKey = (u: NonNullable<ModelChoice["unavailable"]>): Key => (u === "offline" ? "models.offline" : "models.signedOut");

export function ChoiceOption({ o, label, t }: { o: Pick<ModelChoice, "value" | "unavailable">; label: string; t: T }) {
  return (
    <option value={o.value} disabled={Boolean(o.unavailable)}>
      {o.unavailable ? `${label} (${t(reasonKey(o.unavailable))})` : label}
    </option>
  );
}

/** A saved value outside the offered choices: kept selected, marked as not available here. */
export function SavedChoice({ value, t }: { value: string; t: T }) {
  return (
    <option value={value} disabled>
      {value} ({t("models.savedMissing")})
    </option>
  );
}
