# 隐私政策 / Privacy Policy

**NIKKE 装备洗词条期望计算器**（Firefox / Microsoft Edge 扩展，版本 `1.1.2`）
生效日期：2026 年 11 月 27 日 · 最后更新：2026 年 11 月 27 日

> 排版版本：<https://hoomarck.github.io/NIKKE_calc_addon/privacy-policy.html>

---

## 中文

### 一、适用范围

本政策适用于「NIKKE 装备洗词条期望计算器」浏览器扩展（Firefox 与 Microsoft Edge 版本，以下称「本扩展」）。本扩展是一款纯客户端计算工具，用于估算《胜利女神：妮姬》企业装（T10）词条的洗练期望消耗与最优锁定策略。

**一句话概括：本扩展不收集、不上传、不出售任何用户数据。** 所有数据都停留在你自己的浏览器里，唯一的对外请求是代替你向 `blablalink.com` 读取你自己账号的角色与装备信息。

### 二、我们不收集的信息

- 不收集姓名、邮箱、地址、电话等任何可识别个人身份的信息；没有注册、登录或账号体系。
- 不收集浏览历史、网页内容、点击行为、鼠标或键盘记录。
- 不使用统计分析、埋点、崩溃上报或广告 SDK（无 Google Analytics、Sentry、Umami 等）。
- 不向开发者服务器或任何第三方传输、共享、出售用户数据；本扩展不运营任何后端服务器。

### 三、本扩展读取哪些数据，以及为什么

「角色装备导入」是**可选功能**。若你选择使用，本扩展仅读取以下数据，且只用于在本地完成计算：

| 数据 | 来源 | 用途 |
| --- | --- | --- |
| 你已登录的 `blablalink.com` 会话 Cookie | 浏览器 Cookie 存储 | 以你本人身份请求你自己的角色与装备数据 |
| 账号资料（昵称、区服 `area_id`） | `api.blablalink.com` | 展示同步状态、确定请求所属区服 |
| 你拥有的妮姬列表 | `api.blablalink.com` | 供你选择要计算的游戏角色 |
| 角色四件装备及词条（类型、阶数、数值） | `api.blablalink.com` | 填入「初始状态」并生成四装备词条汇总 |
| 名称与数值对照表（公开静态 JSON） | `sg-tools-cdn.blablalink.com` | 把词条 ID 翻译为名称与百分比 |

若你不想让本扩展读取上述数据，可直接在计算器中手动录入词条；除主题偏好外，此时本扩展不会发起任何网络请求。

### 四、数据存储位置与保留期限

- 数据保存在本扩展专属的本地存储中（`browser.storage.local` / `chrome.storage.local`），不涉及云端同步，也不与其他扩展或网页共享。
- 存储内容：账号昵称与区服、角色与装备数据快照、会话 Cookie、计算器偏好（主题、目标词条、各部位锁定状态、高级概率参数）。
- 无固定保留期限：数据一直存在，直到你在面板中清除、覆盖，或卸载本扩展（卸载时浏览器会自动删除全部本地数据）。

### 五、数据传输与共享

- 只与你主动使用过的 `blablalink.com` 通信，请求内容为你自己的游戏数据，不附加开发者标识或额外个人信息。
- **不使用远程代码**：全部 JavaScript、HTML、CSS 均打包在扩展内，无 `eval`、无远程脚本标签、无外部模块加载；网络获取的只有上述 JSON 数据，仅作数据处理，不会被执行。
- 不包含广告、推广链接、联盟追踪或任何形式的数据变现。

### 六、你的控制权

- **随时清除**：面板中的「清空」可删除同步日志、角色数据与已保存的会话 Cookie。
- **撤回站点权限**：在 `about:addons` / `edge://extensions` 中关闭本站点访问权限，同步功能失效，其余计算功能不受影响。
- **完全移除**：卸载扩展即可删除全部本地数据。

### 七、权限用途

| 权限 | 用途 |
| --- | --- |
| `cookies` | 读取你已登录的 blablalink.com 会话，代你请求自己的数据 |
| `storage` | 在本机保存计算偏好与装备数据快照 |
| `tabs` | 仅检测本扩展自己的计算器页面是否已打开，避免重复开标签页 |
| `sidePanel` / `sidebar_action` | 在侧边栏展示扩展自带的同步面板 |
| `declarativeNetRequest`（含 HostAccess） | 将你自己的会话 Cookie 附加到发往 `api.blablalink.com` 的请求，规则仅匹配该域名 |
| `*://*.blablalink.com/*` | 调用该站点自身的 API 与公开静态数据目录 |

### 八、第三方服务

本扩展会访问 `blablalink.com`（含 `api.blablalink.com` 与 `sg-tools-cdn.blablalink.com`）。这些请求由你的浏览器直接发出，遵循该站点自身的隐私政策与服务条款，本扩展无法控制其数据处理行为。除该站点外，本扩展不与任何第三方通信。

### 九、儿童隐私

本扩展不面向 13 岁以下儿童，也不会收集儿童个人信息。如前所述，本扩展本身不收集任何个人信息。

### 十、政策变更与联系方式

若数据处理方式发生变化，本页会同步更新「最后更新」日期；实质性变更会在扩展更新说明中注明。

如有疑问、数据删除请求或安全问题，请在 <https://github.com/Hoomarck/NIKKE_calc_addon/issues> 提交 Issue。

---

## English

### 1. Scope

This policy covers the browser extension "NIKKE Gear Substats Expectation Calculator" (Firefox and Microsoft Edge builds). It is a fully client-side calculator that estimates the expected material cost and optimal locking strategy for rerolling Overload (T10) gear substats in *Goddess of Victory: Nikke*.

**In one sentence: the extension does not collect, upload, or sell any user data.** Everything stays in your own browser. The only outbound requests are to `blablalink.com`, on your behalf, to read your own account's data.

### 2. What we do not collect

- No personally identifiable information — there is no sign-up, login, or account system.
- No browsing history, page content, click, mouse, or keystroke logging.
- No analytics, telemetry, crash reporting, or advertising SDKs.
- No transmission to the developer (there are no servers) or any third party; no selling of data.

### 3. What the extension reads, and why

Account import is **optional**. If enabled, the extension reads:

- **Your existing `blablalink.com` session cookies** — to request your own character and equipment data from that site's API, acting as you.
- **Account profile** (nickname, `area_id`) and **your owned Nikkes** — to show sync status and let you pick a character.
- **Each character's four gear pieces and substats** (type, tier, value) — to prefill the calculator and build the four-piece summary.
- **Public static catalog JSON** from `sg-tools-cdn.blablalink.com` — only to map substat IDs to names and percentages.

If you prefer not to share any of this, skip the sync feature and enter substats manually; apart from your theme preference the extension then makes no network requests.

### 4. Storage and retention

Data is stored in the extension's own local storage (`browser.storage.local` / `chrome.storage.local`). No cloud sync, no sharing with other extensions or sites. Stored: nickname and area, gear snapshot, session cookies, and calculator preferences. There is no fixed retention period; data remains until you clear it or uninstall the extension, at which point the browser deletes it.

### 5. Transmission and sharing

- Communicates only with `blablalink.com`, carrying only your own game data; no developer identifier is attached.
- **No remote code**: all JavaScript, HTML, and CSS are packaged in the extension; no `eval`, remote script tags, or external module loading. Remote JSON is parsed as data and never executed.
- No ads, affiliate links, tracking, or monetization.

### 6. Your controls

- **Clear anytime** — the panel's clear action deletes logs, character data, and stored cookies.
- **Revoke site access** — in `about:addons` or `edge://extensions`; sync stops working, calculation still works.
- **Remove everything** — uninstall the extension.

### 7. Permissions

| Permission | Purpose |
| --- | --- |
| `cookies` | Read your existing blablalink.com session to request your own data |
| `storage` | Keep calculator preferences and the gear snapshot locally |
| `tabs` | Detect whether the extension's own calculator page is already open |
| `sidePanel` / `sidebar_action` | Show the extension's own sync panel in the side panel |
| `declarativeNetRequest` (+ HostAccess) | Attach your session cookie to the extension's requests to `api.blablalink.com`; matches that host only |
| `*://*.blablalink.com/*` | Call that site's own API and public static catalog |

### 8. Third-party services

The extension contacts `blablalink.com` (including `api.blablalink.com` and `sg-tools-cdn.blablalink.com`). Those requests originate from your browser and are governed by that site's own policy and terms; the extension cannot control its processing. No other third party is contacted.

### 9. Children

Not directed to children under 13; no personal information is collected at all.

### 10. Changes and contact

Material changes will be noted in the release notes and reflected in the "last updated" date. Questions, deletion requests, or security reports: <https://github.com/Hoomarck/NIKKE_calc_addon/issues>.

---

本扩展与 Shift Up / Level Infinite 无关，为社区第三方工具。
Not affiliated with Shift Up or Level Infinite; a community-made third-party tool.
