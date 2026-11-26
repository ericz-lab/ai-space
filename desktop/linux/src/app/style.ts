import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import { ICON_RADIUS_MAX } from "../core/catalogue.ts";

/** An icon's corner follows its size and GTK's CSS has no relative radius: one class per pixel (core/catalogue.ts iconShape). */
const ICON_SHAPES = Array.from({ length: ICON_RADIUS_MAX }, (_, i) => `.icon-r${i + 1} { border-radius: ${i + 1}px; }`).join("\n");

/** The few styles libadwaita does not already give: tiles, chat bubbles, tool rows and cards. Colours are Adwaita's named ones, so light and dark follow the desktop. */
const CSS = `
.tile { padding: 10px 4px 8px; border-radius: 16px; min-width: 96px; }
.tile-title { font-size: 0.92em; }
${ICON_SHAPES}
.icon-round { border-radius: 99px; }
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
.wl-area .widget-card { min-width: 0; }
.widget-card.resizing { box-shadow: inset 0 0 0 2px alpha(@accent_bg_color, 0.7); }
.wb-linked { border-radius: 10px; }
.wb-linked:hover { background: alpha(@window_fg_color, 0.04); }
.wb-check { min-width: 16px; min-height: 16px; padding: 0; border-radius: 99px; border: 1.5px solid alpha(@window_fg_color, 0.45); background: none; box-shadow: none; }
.wb-check:hover { border-color: @accent_bg_color; }
.wb-check.on { background: @accent_bg_color; border-color: @accent_bg_color; color: @accent_fg_color; }
.wb-done { color: alpha(@window_fg_color, 0.5); }
.wb-copy { min-width: 24px; min-height: 24px; padding: 0; }
.wb-btn { min-height: 24px; padding: 0 10px; font-size: 0.9em; }
.wb-views button { min-height: 26px; padding: 0 10px; font-size: 0.9em; }
.wb-pager { margin-top: -4px; }
.wb-pdot { min-width: 22px; min-height: 22px; padding: 0; }
.wb-pdot-mark { min-width: 6px; min-height: 6px; border-radius: 99px; background: alpha(@window_fg_color, 0.22); }
.wb-pdot.on .wb-pdot-mark { background: @window_fg_color; }
.wb-asof { min-height: 24px; padding: 0 6px; color: alpha(@window_fg_color, 0.6); }
.wb-asof.outdated { color: @warning_color; }
.wb-readout { color: @accent_color; padding: 0 4px; }
.wb-hero, .wb-row-value, .wb-status { transition: color 600ms ease-out, background-color 600ms ease-out; }
.wb-flash-up { color: #2ea043; }
.wb-flash-down { color: @error_color; }
.wb-flash-text { background-color: alpha(@window_fg_color, 0.12); border-radius: 4px; }
.wb-confirm { padding: 6px 8px; border-radius: 10px; background: alpha(@window_fg_color, 0.05); }
.wl-handle { border-radius: 4px; }
.wl-handle:hover, .wl-handle:focus-visible { background: alpha(@accent_bg_color, 0.45); }
.wl-xy { border-radius: 4px 4px 10px 4px; background: alpha(@window_fg_color, 0.18); }
.wl-toolbar { padding: 6px; border-radius: 12px; background: alpha(@window_fg_color, 0.04); }
.wl-confirm label { margin: 0 4px; }
.tone-positive { color: #2ea043; }
.tone-negative { color: @error_color; }
.tone-warning { color: @warning_color; }
.pager-dot { min-width: 22px; min-height: 22px; padding: 0 4px; border-radius: 99px; font-size: 0.6em; color: alpha(@window_fg_color, 0.3); }
.pager-dot.active { color: @window_fg_color; }
.home-search { min-height: 44px; font-size: 1.1em; border-radius: 22px; padding: 0 14px; }
.ask-row { padding: 10px 14px; border-radius: 12px; }
.voice-recording { color: @error_color; }
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
.pet-bubble { font-size: 12px; padding: 4px 9px; border-radius: 10px; background: alpha(@window_bg_color, 0.94); border: 1px solid alpha(@window_fg_color, 0.1); }
window.quick-chat { background: transparent; }
.qc-panel { border-radius: 16px; background: alpha(@window_bg_color, 0.96); border: 1px solid alpha(@window_fg_color, 0.1); }
.qc, .qc-panel { font-size: 13px; }
.qc-agent { padding: 3px 6px; min-height: 0; border-radius: 7px; }
.qc-agent-name { font-weight: 600; }
.qc-round { min-width: 20px; min-height: 20px; padding: 0; border-radius: 99px; background: alpha(#78787f, 0.14); color: alpha(@window_fg_color, 0.6); }
.qc-round:hover { background: alpha(#78787f, 0.24); }
.qc-round:disabled { opacity: 0.4; }
.qc-field { padding: 8px 10px; border-radius: 10px; background: alpha(@view_bg_color, 0.7); border: 1px solid alpha(@window_fg_color, 0.08); }
.qc-field.focused { border-color: alpha(@accent_color, 0.6); }
.qc-field textview, .qc-field textview text { background: transparent; }
.qc-hint { font-size: 11px; color: alpha(@window_fg_color, 0.55); }
.qc-hint.dim { color: alpha(@window_fg_color, 0.3); }
.qc-agent-row { padding: 6px 8px; border-radius: 8px; }
.qc-avatar { border-radius: 99px; }
.qc-round.qc-open { background: alpha(#ff9500, 0.18); color: #ff9500; }
.qc-round > button, menubutton.qc-round > button { min-width: 20px; min-height: 20px; padding: 0; border-radius: 99px; background: transparent; }
.qc-stop { min-width: 20px; min-height: 20px; padding: 0; color: @error_color; }
.qc-field textview { min-height: 20px; }
/* Chat cards (docs/chat-cards.md, app/chat-cards.ts): the web's chat-card look in the theme's colours. */
.chat-card { background: @card_bg_color; color: @card_fg_color; border: 1px solid alpha(@window_fg_color, 0.1); border-radius: 12px; }
.chat-card.live { box-shadow: 0 1px 2px alpha(@shade_color, 0.5), 0 6px 18px @shade_color; }
.chat-card-sep { background: alpha(@window_fg_color, 0.1); min-height: 1px; }
.chat-card-head { min-height: 52px; padding: 0 10px 0 14px; font-size: 13px; }
.chat-card-app-icon { border-radius: 6px; }
.chat-card-app-icon.solid { background: alpha(@window_fg_color, 0.07); }
.chat-card-app { font-weight: 600; }
.chat-card-title { color: alpha(@card_fg_color, 0.6); font-weight: 500; }
.chat-card-undo { min-height: 30px; padding: 0 12px 0 10px; border-radius: 99px; background: transparent; box-shadow: inset 0 0 0 1px alpha(@window_fg_color, 0.14); font-size: 13px; font-weight: 500; }
.chat-card-undo:hover { background: alpha(@window_fg_color, 0.06); }
.chat-card-value { padding: 12px 14px; font-size: 22px; font-weight: 600; }
.chat-card-row { padding: 10px 14px; }
.chat-card-row.acts { padding-right: 10px; }
.chat-card-row.single { padding: 12px 14px; }
.chat-card-row.removed { background: alpha(@window_fg_color, 0.04); }
.chat-card-press { padding: 0; margin: 0; border-radius: 0; min-height: 0; font-weight: normal; }
.chat-card-press:hover { background: alpha(@window_fg_color, 0.04); }
.chat-card-mark { min-width: 15px; min-height: 15px; border-radius: 99px; border: 1.5px solid alpha(@card_fg_color, 0.35); }
.chat-card-mark.removed { border-style: dashed; border-color: alpha(@card_fg_color, 0.3); }
.chat-card-mark.done { border-color: @success_color; background: @success_color; color: @success_fg_color; }
.chat-card-icon { color: alpha(@card_fg_color, 0.6); }
.chat-card-name { font-size: 14px; font-weight: 600; }
.chat-card-name > link { color: @card_fg_color; text-decoration: none; }
.chat-card-name > link:hover { color: @accent_color; }
.chat-card-row.done .chat-card-name, .chat-card-row.removed .chat-card-name { font-weight: 500; color: alpha(@card_fg_color, 0.6); }
.chat-card-row.removed .chat-card-name, .struck { text-decoration-line: line-through; }
.chat-card-meta { font-size: 12px; color: alpha(@card_fg_color, 0.6); font-feature-settings: "tnum"; }
.chat-card-meta flowboxchild { padding: 0; min-height: 0; }
.chat-card-time { color: @card_fg_color; font-weight: 500; }
.chat-card-tag { min-height: 18px; padding: 0 7px; border-radius: 99px; font-size: 12px; font-weight: 500; color: alpha(@card_fg_color, 0.6); background: alpha(@window_fg_color, 0.07); }
.chat-card-tag.tone-accent { color: mix(@accent_color, @card_fg_color, 0.4); background: alpha(@accent_bg_color, 0.14); }
.chat-card-tag.tone-positive { color: mix(@success_color, @card_fg_color, 0.4); background: alpha(@success_color, 0.14); }
.chat-card-tag.tone-warning { color: mix(@warning_color, @card_fg_color, 0.5); background: alpha(@warning_color, 0.14); }
.chat-card-tag.tone-negative { color: mix(@error_color, @card_fg_color, 0.4); background: alpha(@error_color, 0.12); }
.chat-card-pill { font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 99px; color: alpha(@card_fg_color, 0.6); background: alpha(@window_fg_color, 0.07); }
.chat-card-pill.ok { color: mix(@success_color, @card_fg_color, 0.4); background: alpha(@success_color, 0.14); }
.chat-card-pill.warn { color: mix(@warning_color, @card_fg_color, 0.5); background: alpha(@warning_color, 0.14); }
.chat-card-gone { background: alpha(@card_bg_color, 0.85); }
.chat-card-row-undo { min-width: 32px; min-height: 32px; padding: 0; color: alpha(@card_fg_color, 0.6); }
.chat-card-row-undo:hover { color: @card_fg_color; }
.chat-card-progress trough { min-height: 3px; border-radius: 99px; background: alpha(@window_fg_color, 0.1); }
.chat-card-progress progress { min-height: 3px; border-radius: 99px; background: @accent_bg_color; }
.chat-card-thumb.small { border-radius: 8px; }
.chat-card-thumb.large { border-radius: 10px; margin-bottom: 4px; }
.chat-card-thumb-empty { background: alpha(@window_fg_color, 0.1); }
.chat-card-compact { min-height: 36px; padding: 0 14px; }
.chat-card-dot { min-width: 6px; min-height: 6px; border-radius: 99px; background: alpha(@card_fg_color, 0.6); }
.chat-card-dot.done { background: @success_color; }
.chat-card-dot.removed { background: transparent; box-shadow: inset 0 0 0 1px alpha(@card_fg_color, 0.6); }
.chat-card-compact-title { font-size: 14px; font-weight: 500; }
.chat-card-compact.done .chat-card-compact-title, .chat-card-compact.removed .chat-card-compact-title { color: alpha(@card_fg_color, 0.6); }
.chat-card-compact.removed .chat-card-compact-title { text-decoration-line: line-through; }
.chat-card-compact-value { font-size: 12px; color: alpha(@card_fg_color, 0.6); }
.chat-card-gallery { padding: 12px; }
.chat-card-gallery > flowboxchild { padding: 0; border-radius: 10px; }
.chat-card-cell-title { font-size: 13px; font-weight: 500; }
.chat-card-cell-title.struck { color: alpha(@card_fg_color, 0.6); }
.chat-card-cell-sub { font-size: 12px; color: alpha(@card_fg_color, 0.6); font-feature-settings: "tnum"; }
.chat-card-thumb-undo { min-width: 28px; min-height: 28px; padding: 0; color: @card_fg_color; background: alpha(@card_bg_color, 0.72); }
.chat-card-thumb-undo:hover { background: @card_bg_color; }
.chat-card-day-num { font-size: 18px; font-weight: 700; }
.chat-card-day-sub { font-size: 11px; color: alpha(@card_fg_color, 0.6); }
.chat-card-stats { background: alpha(@window_fg_color, 0.1); }
.chat-card-stats > flowboxchild { padding: 0; background: @card_bg_color; }
.chat-card-stat { padding: 12px; }
.chat-card-stat-value { font-size: 22px; font-weight: 700; }
.chat-card-stat-title { font-size: 12px; color: alpha(@card_fg_color, 0.6); }
.chat-card-note { padding: 8px 14px; font-size: 12px; color: alpha(@card_fg_color, 0.6); }
.chat-card-note.error { color: @error_color; }
`;

/** On the default display, or on another one the app shows windows on (Quick Chat's X11 one). */
export function installStyles(display: any = Gdk.Display.get_default()): void {
  const provider = new Gtk.CssProvider();
  provider.load_from_string(CSS);
  Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}
