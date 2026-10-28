using System.Collections.Generic;
using System.Globalization;

namespace AISpace.Windows;

/// <summary>The client's words in English and Chinese, chosen by Windows' display language (as the other clients do).</summary>
static class Strings
{
    public static readonly bool Chinese = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh";
    public static string Lang => Chinese ? "zh" : "en";

    static readonly Dictionary<string, (string En, string Zh)> Table = new()
    {
        ["app"] = ("AI Space", "AI Space"),
        ["quickChat"] = ("Quick Chat", "快速对话"),
        ["settings"] = ("Settings…", "设置…"),
        ["showBall"] = ("Show the floating ball", "显示悬浮球"),
        ["hideBall"] = ("Hide Floating Ball", "隐藏悬浮球"),
        ["quit"] = ("Quit AI Space", "退出 AI Space"),
        ["address"] = ("Space address", "Space 地址"),
        ["token"] = ("Device token", "设备令牌"),
        ["tokenHint"] = ("On the Space's computer, run: space auth device-add windows — and paste the spd_… token it prints.", "在 Space 所在的电脑上运行：space auth device-add windows，再粘贴它打印的 spd_… 令牌。"),
        ["check"] = ("Check", "检查"),
        ["checking"] = ("Checking…", "正在检查…"),
        ["connected"] = ("Connected: {0} apps, {1} agents.", "已连接：{0} 个应用，{1} 个智能体。"),
        ["save"] = ("Save", "保存"),
        ["cancel"] = ("Cancel", "取消"),
        ["sections"] = ("Floating ball sections", "悬浮球分区"),
        ["sectionsHint"] = ("Rest the pointer on the ball for four sections: click one to hand text and pictures to that app's agent (Space Assistant when the app has none), or drop a picture on it. Each Space keeps its own sections.", "鼠标停在小球上会展开四个分区：点一个，把文字和图片交给该应用的智能体（应用没有智能体时交给 Space 助手），也可以把图片直接拖到分区上。每个空间各自保存自己的分区。"),
        ["top"] = ("Top", "上"),
        ["right"] = ("Right", "右"),
        ["bottom"] = ("Bottom", "下"),
        ["left"] = ("Left", "左"),
        ["default"] = ("Default ({0})", "默认（{0}）"),
        ["none"] = ("None", "无"),
        ["addInSettings"] = ("Add in Settings…", "在设置中添加…"),
        ["sendTo"] = ("Send to {0}", "交给 {0}"),
        ["saveTo"] = ("Save this to {0}:", "把下面的内容存进 {0}："),
        ["handTo"] = ("Hand it to {0}…", "交给 {0}…"),
        ["addToReply"] = ("Add to the reply in progress…", "补充到正在进行的回复…"),
        ["send"] = ("↩ Send", "↩ 发送"),
        ["stop"] = ("Stop", "停止"),
        ["newConversation"] = ("New Conversation (Ctrl+N)", "新对话（Ctrl+N）"),
        ["close"] = ("Close (Esc)", "关闭（Esc）"),
        ["allow"] = ("Allow", "允许"),
        ["deny"] = ("Deny", "拒绝"),
        ["noAgent"] = ("Connect to a Space in Settings to talk to its agents.", "在设置中连接一个 Space，才能和它的智能体对话。"),
        ["onePicture"] = ("Drop one picture at a time.", "一次只能拖一张图片。"),
        ["notAPicture"] = ("That is not a picture.", "这不是图片。"),
        ["unreadable"] = ("Could not read this picture.", "无法读取这张图片。"),
        ["tooMany"] = ("Add up to 4 images, 5 MB each and 10 MB in total.", "最多 4 张图片，每张 5 MB，总共 10 MB。"),
        ["signIn"] = ("The Space asks for a sign-in: check the device token in Settings.", "Space 要求登录：请在设置中检查设备令牌。"),
        ["remove"] = ("Remove image", "移除图片"),
    };

    public static string T(string key, params object[] args)
    {
        var (en, zh) = Table[key];
        var text = Chinese ? zh : en;
        return args.Length == 0 ? text : string.Format(CultureInfo.CurrentCulture, text, args);
    }
}
