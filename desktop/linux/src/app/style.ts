import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";

/** The few styles libadwaita does not already give: tiles, chat bubbles, tool rows and cards. Colours are Adwaita's named ones, so light and dark follow the desktop. */
const CSS = `
.tile { padding: 10px 4px 8px; border-radius: 16px; min-width: 96px; }
.tile-title { font-size: 0.92em; }
.tile-icon { border-radius: 14px; }
.tile-emoji { margin: 0; }
.reach-dot { min-width: 8px; min-height: 8px; border-radius: 99px; }
.reach-down { background: @error_color; }
.reach-paused { background: @warning_color; }
.unread-dot { background: @accent_bg_color; }
.reach-peer-offline { background: alpha(@window_fg_color, 0.35); }
.section-title { font-weight: 700; font-size: 1.05em; margin: 18px 6px 6px; }
.widget-card { padding: 8px 10px 14px; border-radius: 18px; min-width: 280px; }
.wb-head { padding: 6px 6px; border-radius: 12px; }
.wb-title { font-weight: 500; }
.wb-link { padding: 4px 6px; margin: -4px -6px; border-radius: 10px; font-weight: normal; }
.wb-hero { font-size: 1.9em; font-weight: 600; font-feature-settings: "tnum"; }
.wb-status { font-size: 1.15em; font-weight: 600; }
.wb-row-label { color: alpha(@window_fg_color, 0.78); }
.wb-row-value { font-weight: 600; font-feature-settings: "tnum"; }
.wb-delta { font-weight: 600; font-feature-settings: "tnum"; }
.wb-item { font-size: 0.97em; }
.wb-embed { border-radius: 10px; }
.tone-positive { color: #2ea043; }
.tone-negative { color: @error_color; }
.tone-warning { color: @warning_color; }
.pager-dot { min-width: 22px; min-height: 22px; padding: 0 4px; border-radius: 99px; font-size: 0.6em; color: alpha(@window_fg_color, 0.3); }
.pager-dot.active { color: @window_fg_color; }
.home-search { min-height: 44px; font-size: 1.1em; border-radius: 22px; padding: 0 14px; }
.ask-row { padding: 10px 14px; border-radius: 12px; }
.user-bubble { background: @accent_bg_color; color: @accent_fg_color; border-radius: 18px 18px 6px 18px; padding: 8px 14px; }
.user-bubble label { color: @accent_fg_color; }
.agent-message { padding: 2px 2px; }
.md-heading-1 { font-size: 1.35em; font-weight: 800; }
.md-heading-2 { font-size: 1.2em; font-weight: 700; }
.md-heading-3 { font-size: 1.08em; font-weight: 700; }
.md-quote { border-left: 3px solid alpha(@window_fg_color, 0.2); padding-left: 10px; }
.md-code { font-family: monospace; font-size: 0.92em; padding: 8px 10px; border-radius: 10px; background: alpha(@window_fg_color, 0.06); }
.tool-group { padding: 2px 0; }
.tool-row { font-size: 0.92em; }
.tool-kind { font-weight: 600; }
.tool-dot { font-size: 0.7em; }
.tool-ok { color: @success_color; }
.tool-failed, .tool-failed label { color: @error_color; }
.tool-running { color: @accent_color; }
.tool-detail { font-family: monospace; font-size: 0.88em; padding: 6px 8px; border-radius: 8px; background: alpha(@window_fg_color, 0.05); }
.card-inner { padding: 12px 14px; }
.failure-card { border: 1px solid alpha(@error_color, 0.35); }
.composer { border-radius: 18px; padding: 6px 8px; }
.composer textview, .composer textview text { background: transparent; }
.attachment { border-radius: 8px; }
.pending-line, .activity-line { font-size: 0.92em; }
.inbox-time { font-size: 0.9em; }
.status-dot { min-width: 8px; min-height: 8px; border-radius: 99px; background: alpha(@window_fg_color, 0.3); }
.status-ok { background: @success_color; }
.status-down { background: @error_color; }
.status-paused { background: @warning_color; }
.status-running { background: @accent_bg_color; }
.status-off { background: alpha(@window_fg_color, 0.18); }
.usage-card { padding: 10px 14px; }
.usage-figure { font-size: 1.4em; font-weight: 600; font-feature-settings: "tnum"; }
.table-cell, .numeric { font-feature-settings: "tnum"; }
.small-toggle { padding: 2px 10px; min-height: 24px; font-size: 0.9em; }
.run-output { font-size: 0.88em; padding: 8px 12px; }
.setnote { font-size: 0.92em; }
.sidebar-heading { font-weight: 700; font-size: 0.85em; margin: 12px 12px 4px; }
`;

export function installStyles(): void {
  const provider = new Gtk.CssProvider();
  provider.load_from_string(CSS);
  Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}
