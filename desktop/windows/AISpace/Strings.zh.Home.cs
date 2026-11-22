namespace AISpace;

internal static partial class L
{
    /// <summary>The Chinese of Home: engineer B (Strings.cs says which table holds what).</summary>
    private static readonly Dictionary<string, string> ZhHome = new()
    {
        // The command box and the tabs.
        ["Search apps, agents and widgets, or ask Space Assistant"] = "搜索应用、智能体和小组件，或询问 Space 助手",
        ["Ask Space Assistant: “{0}”"] = "询问 Space 助手：“{0}”",
        ["Enter asks Space Assistant"] = "按回车询问 Space 助手",
        ["Ctrl+Enter asks Space Assistant"] = "按 Ctrl+回车询问 Space 助手",
        ["Nothing matches. Press Enter to ask Space Assistant."] = "没有匹配项。按回车询问 Space 助手。",
        ["Library"] = "资源库",
        ["Main"] = "主屏幕",
        ["Screen {0}"] = "屏幕 {0}",
        ["More screens"] = "更多屏幕",
        ["Filter by kind"] = "按类型筛选",
        ["All"] = "全部",
        ["Agents"] = "智能体",
        ["Widgets"] = "小组件",
        ["None of this kind yet"] = "还没有这一类内容",

        // The App Store and the first-use card.
        ["App Store"] = "应用商店",
        ["Add your first apps"] = "添加第一批应用",
        ["The App Store has {0} apps for this Space. Install the ones you want there; they are added to this screen."] = "应用商店里有 {0} 个应用可以装到这个空间，去那里挑想要的安装，装好的会加到这个屏幕上。",
        ["Open the App Store"] = "打开应用商店",
        ["Not Now"] = "以后再说",

        // The page's states.
        ["Loading the Space…"] = "正在读取空间…",
        ["Home could not be loaded"] = "无法加载主页",
        ["Showing what was last known ({0})."] = "显示的是上次获取的内容（{0}）。",

        // Tiles.
        ["Working on a reply"] = "正在回复",
        ["not answering"] = "无响应",
        ["paused"] = "已暂停",
        ["{0} offline"] = "{0} 离线",
        ["On {0}"] = "位于 {0}",

        // Screens.
        ["Nothing on this screen yet"] = "这个屏幕上还没有内容",
        ["Right-click an app, agent or widget in the Library (or press Shift+F10 on it) and choose a screen to add it."] = "在资源库中右键点击应用、智能体或小组件（或选中后按 Shift+F10），选择要添加到的屏幕。",
        ["Open Library"] = "打开资源库",
        ["Open {0}"] = "打开{0}",
        ["Remove from This Screen"] = "从此屏幕移除",
        ["Add to Main Screen"] = "添加到主屏幕",
        ["Remove from Main Screen"] = "从主屏幕移除",
        ["On Screens"] = "所在屏幕",
        ["Move Earlier"] = "前移",
        ["Move Later"] = "后移",
        ["Copy Link"] = "复制链接",
        ["The clipboard is busy. Try again."] = "剪贴板正被占用，请再试一次。",
        ["New Screen"] = "新建屏幕",
        ["Rename Screen…"] = "重命名屏幕…",
        ["Rename Screen"] = "重命名屏幕",
        ["Screen name"] = "屏幕名称",
        ["Leave it empty for the screen's number ({0})."] = "留空则使用屏幕编号（{0}）。",
        ["Copy the Web Panel's Layout…"] = "复制网页面板的布局…",
        ["Replace this computer's screens?"] = "替换这台电脑上的屏幕？",
        ["The screens here become a copy of the web panel's as it is now. The web panel does not change."] = "这里的屏幕将变为网页面板当前布局的副本。网页面板本身不会改变。",
        ["Delete Screen…"] = "删除屏幕…",
        ["Delete this screen?"] = "删除这个屏幕？",
        ["Its apps, agents and widgets stay in the Library."] = "其中的应用、智能体和小组件仍保留在资源库中。",

        // Widget cards.
        ["No data"] = "无数据",
        ["No history yet"] = "暂无历史",
        ["Not answering"] = "无响应",
        ["Nothing to show."] = "没有可显示的内容。",
        ["Last known; its machine is offline."] = "上次已知的内容；其所在机器离线。",
        ["Updated {0}"] = "更新于{0}",
        ["This widget shows its app's own page."] = "这个小组件显示的是其应用自己的页面。",

        // Ages.
        ["just now"] = "刚刚",
        ["1 minute ago"] = "1分钟前",
        ["{0} minutes ago"] = "{0}分钟前",
        ["in 1 minute"] = "1分钟后",
        ["in {0} minutes"] = "{0}分钟后",
        ["1 hour ago"] = "1小时前",
        ["{0} hours ago"] = "{0}小时前",
        ["in 1 hour"] = "1小时后",
        ["in {0} hours"] = "{0}小时后",
        ["yesterday"] = "昨天",
        ["tomorrow"] = "明天",
        ["{0} days ago"] = "{0}天前",
        ["in {0} days"] = "{0}天后",
    };
}
