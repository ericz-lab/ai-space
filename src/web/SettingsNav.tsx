import type { ReactNode } from "react";
import type { Key } from "./i18n.ts";

// The settings dialog's sections: a list on the left, one section's cards on the right.
export type SettingsSection = "general" | "appearance" | "models" | "automation" | "usage" | "status" | "packages" | "account";

const ICONS: Record<SettingsSection, ReactNode> = {
  general: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.6V3.2M8 12.8V14.4M1.6 8H3.2M12.8 8H14.4M3.5 3.5L4.6 4.6M11.4 11.4L12.5 12.5M3.5 12.5L4.6 11.4M11.4 4.6L12.5 3.5" /></>,
  appearance: <><circle cx="8" cy="8" r="6.2" /><path d="M8 1.8V14.2" /><path d="M8 1.8A6.2 6.2 0 0 1 8 14.2Z" fill="currentColor" stroke="none" /></>,
  models: <><ellipse cx="8" cy="3.8" rx="5.4" ry="2" /><path d="M2.6 3.8V8C2.6 9.1 5 10 8 10S13.4 9.1 13.4 8V3.8" /><path d="M2.6 8V12.2C2.6 13.3 5 14.2 8 14.2S13.4 13.3 13.4 12.2V8" /></>,
  automation: <><circle cx="8" cy="8" r="6.2" /><path d="M8 4.6V8L10.4 9.6" /></>,
  usage: <><path d="M2.4 13.6H13.6" /><path d="M4.4 11V7.6" /><path d="M8 11V3.8" /><path d="M11.6 11V6" /></>,
  status: <path d="M1.8 8.4H4.6L6.4 4L9.4 12.4L11.2 8.4H14.2" />,
  packages: <><path d="M8 1.8L13.6 4.6V11.4L8 14.2L2.4 11.4V4.6Z" /><path d="M2.4 4.6L8 7.4L13.6 4.6" /><path d="M8 7.4V14.2" /></>,
  account: <><circle cx="8" cy="5.6" r="2.8" /><path d="M2.8 14C3.4 11.4 5.5 9.9 8 9.9S12.6 11.4 13.2 14" /></>,
};

export const SECTION_LABEL: Record<SettingsSection, Key> = {
  general: "settings.section.general",
  appearance: "settings.section.appearance",
  models: "settings.section.models",
  automation: "settings.section.automation",
  usage: "settings.section.usage",
  status: "settings.status",
  packages: "settings.section.packages",
  account: "auth.account",
};

export const SectionIcon = ({ name }: { name: SettingsSection }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {ICONS[name]}
  </svg>
);

const STORE = "settings-section";
/** The section shown last, so reopening the dialog lands where the person left it. */
export function savedSection(sections: SettingsSection[]): SettingsSection {
  try {
    const s = localStorage.getItem(STORE) as SettingsSection | null;
    if (s && sections.includes(s)) return s;
  } catch { /* storage blocked */ }
  return sections[0]!;
}
export function saveSection(s: SettingsSection): void {
  try { localStorage.setItem(STORE, s); } catch { /* storage blocked */ }
}

export function SettingsNav({ sections, current, onPick, t }: { sections: SettingsSection[]; current: SettingsSection; onPick: (s: SettingsSection) => void; t: (k: Key) => string }) {
  return (
    <nav className="setnav" aria-label={t("settings.title")}>
      {sections.map((s) => (
        <button key={s} className={s === current ? "on" : ""} aria-current={s === current ? "page" : undefined} onClick={() => onPick(s)}>
          <SectionIcon name={s} />
          <span>{t(SECTION_LABEL[s])}</span>
        </button>
      ))}
    </nav>
  );
}
