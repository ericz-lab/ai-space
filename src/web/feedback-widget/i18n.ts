/** The feedback button's words, in the page's language (docs/feedback.md#the-button). */

const en = {
  title: "Feedback",
  button: "Feedback (Alt+Shift+F)",
  placeholder: "What's wrong? One sentence is enough.",
  pick: "Pick element",
  shot: "Screenshot",
  attach: "Attach",
  now: "Fix now",
  later: "Fix later",
  mode: "What happens next",
  send: "Send",
  sending: "Sending…",
  close: "Close",
  hide: "Hide on this page",
  pickClick: "Click an element",
  pickTap: "Tap an element",
  toCancel: "to cancel",
  cancel: "Cancel",
  saved: "Saved as todo #{n}",
  savedPlain: "Saved",
  fixingNow: "Fixing now",
  fixLater: "Fix later",
  open: "Open",
  remove: "Remove {name}",
  recent: "Recent",
  empty: "Write a sentence first.",
  errOff: "Feedback is turned off for this app.",
  errTooLarge: "The pictures are too large.",
  errTooMany: "Too much feedback in the last hour; try again later.",
  errNetwork: "Could not send: the Space did not answer. Your text is kept.",
  errGeneric: "Could not send: {msg}. Your text is kept.",
  shotCancelled: "No screenshot taken.",
  imageTooLarge: "That picture is larger than 3 MB.",
  maxImages: "At most two pictures.",
  maxElements: "At most five elements.",
  light: "Light",
  dark: "Dark",
  "status.later": "Fix later",
  "status.queued": "Queued",
  "status.fixing": "Fixing",
  "status.review": "Review",
  "status.failed": "Not fixed",
  "status.skipped": "Needs you",
  "status.recorded": "Recorded",
} as const;

export type Key = keyof typeof en;
export type Lang = "en" | "zh";

const zh: Record<Key, string> = {
  title: "反馈",
  button: "反馈（Alt+Shift+F）",
  placeholder: "哪里不对？一句话就够。",
  pick: "选元素",
  shot: "截图",
  attach: "附图",
  now: "马上修",
  later: "稍后一起修",
  mode: "之后怎么处理",
  send: "发送",
  sending: "发送中…",
  close: "关闭",
  hide: "本页先隐藏",
  pickClick: "点选页面上的元素",
  pickTap: "点一下页面上的元素",
  toCancel: "取消",
  cancel: "取消",
  saved: "已记到待办 #{n}",
  savedPlain: "已记录",
  fixingNow: "正在修",
  fixLater: "稍后修",
  open: "查看",
  remove: "移除 {name}",
  recent: "最近",
  empty: "先写一句话。",
  errOff: "这个 app 的反馈已关闭。",
  errTooLarge: "图片太大了。",
  errTooMany: "这一小时的反馈太多了，稍后再试。",
  errNetwork: "发送失败：Space 没有回应，文字已保留。",
  errGeneric: "发送失败：{msg}。文字已保留。",
  shotCancelled: "没有截到图。",
  imageTooLarge: "这张图超过 3 MB。",
  maxImages: "最多两张图。",
  maxElements: "最多五个元素。",
  light: "浅色",
  dark: "暗色",
  "status.later": "稍后修",
  "status.queued": "排队中",
  "status.fixing": "修复中",
  "status.review": "待验收",
  "status.failed": "未修好",
  "status.skipped": "需要你",
  "status.recorded": "已记录",
};

const dict: Record<Lang, Record<Key, string>> = { en, zh };

export function tr(lang: Lang, key: Key, vars: Record<string, string | number> = {}): string {
  return dict[lang][key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}

/** The page's language: its `<html lang>`, Chinese or English. */
export function pageLang(doc: Document): Lang {
  return /^zh/i.test(doc.documentElement.lang || "") ? "zh" : "en";
}
