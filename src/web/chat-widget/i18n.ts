/** The widget's own words; the app's language comes from `opts.lang` or `<html lang>`. */
export type Lang = "zh" | "en";

const T = {
  zh: {
    send: "发送", stop: "停止", newThread: "新对话", deleteThread: "删除对话", threads: "对话", attach: "添加图片", remove: "移除",
    placeholder: "问点什么…（Enter 发送，Shift+Enter 换行）", empty: "还没有对话。", thinking: "思考中…", failed: "失败", copy: "复制", copied: "已复制",
    tooMany: (n: number) => `一条消息最多 ${n} 张图片`, tooBig: (mb: number) => `图片不能超过 ${mb} MB`, notImage: "只支持 png、jpeg、gif、webp", uploadFailed: "上传失败",
    busy: "上一条还在回答", confirmDelete: "删除这段对话？", untitled: "（无标题）", earlierImages: "（更早的图片本次不可见）",
    model: "模型", modelSettings: "选择模型", modelDefault: "默认（跟随 app / 空间默认）", modelInUse: "当前使用", modelSaved: "已切换模型",
    modelFrom: { choice: "你的选择", app: "app 指定", default: "空间默认" }, modelUnavailable: (m: string) => `之前选的 ${m} 已不可用，暂用默认`,
    tiers: { basic: "基础", junior: "初级", intermediate: "中级", advanced: "高级" } as Record<string, string>,
  },
  en: {
    send: "Send", stop: "Stop", newThread: "New chat", deleteThread: "Delete chat", threads: "Chats", attach: "Add image", remove: "Remove",
    placeholder: "Ask something… (Enter to send, Shift+Enter for a new line)", empty: "No conversation yet.", thinking: "Thinking…", failed: "Failed", copy: "Copy", copied: "Copied",
    tooMany: (n: number) => `At most ${n} images per message`, tooBig: (mb: number) => `Images must be under ${mb} MB`, notImage: "Only png, jpeg, gif and webp", uploadFailed: "Upload failed",
    busy: "Still answering the last message", confirmDelete: "Delete this conversation?", untitled: "(untitled)", earlierImages: "(earlier images are not visible this turn)",
    model: "Model", modelSettings: "Choose model", modelDefault: "Default (follow the app / space)", modelInUse: "In use", modelSaved: "Model changed",
    modelFrom: { choice: "your choice", app: "set by the app", default: "space default" }, modelUnavailable: (m: string) => `${m} is no longer available; using the default`,
    tiers: { basic: "Basic", junior: "Junior", intermediate: "Intermediate", advanced: "Advanced" } as Record<string, string>,
  },
} as const;

export type Strings = (typeof T)["zh"];

export function strings(lang: string | undefined): Strings {
  return (lang ?? "").toLowerCase().startsWith("en") ? (T.en as unknown as Strings) : T.zh;
}
