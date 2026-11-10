<p align="center">
  <img src="./icons/logo-a3-master.png" alt="知行视频总结 Logo：黑色资料卡与橙色摘要卡" width="180">
</p>

<h1 align="center">知行视频总结 · VidSift</h1>

<p align="center">
  <strong>从视频到笔记，让知识留下来。</strong>
</p>

<p align="center">
  提取 B站、YouTube、抖音的字幕或音频，交给 ChatGPT 整理。<br>
  按需附上带时间戳的画面拼图，把课件、演示和图表一起纳入理解。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Chrome%20%2F%20Edge-Manifest%20V3-4285F4?style=flat-square" alt="Chrome / Edge · Manifest V3">
  <img src="https://img.shields.io/badge/status-experimental-orange?style=flat-square" alt="测试阶段">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#使用方式">使用方式</a> ·
  <a href="./INSTALL.md">完整安装说明</a> ·
  <a href="./PRIVACY_POLICY.md">隐私说明</a> ·
  <a href="./CHANGELOG.md">更新记录</a>
</p>

- **当前处于测试阶段**，部分真实网站流程仍待验收，本机程序目前提供 Windows 安装脚本。
- 默认流程使用你已登录的 ChatGPT / Google AI Studio 网页，不需要填写 API Key，但需要能访问对应服务并登录账号。

---

## 为什么做这个扩展

- 看完一段课程、访谈或演示后，想留下可回看的笔记，往往还要手动找字幕、转写音频、截取画面，再把材料交给 AI。
- 知行视频总结把这些步骤串在一起，让你从视频页面发起一次任务，再到 ChatGPT 查看整理结果。

```text
有字幕的视频 → 提取字幕 → ChatGPT 整理
无字幕的视频 → 获取音频 → 转写为 SRT → ChatGPT 整理
需要参考画面 → 开启图片提取 → 带时间戳的拼图随内容上传
```

- 例如，整理一段没有字幕的课程时，默认先由 AI Studio 生成完整逐字稿，再交给 ChatGPT 按你的提示词整理知识点和论证关系。
- 你可以分别修改转写和总结提示词，笔记的准确性与完整性仍需要对照原视频核查。

---

## 能做什么

| 功能 | 使用方式与边界 |
|---|---|
| 字幕优先 | 优先使用平台已有字幕，中文优先，减少不必要的下载和转写。 |
| 无字幕转写 | 可选择 AI Studio、浏览器内 Whisper 或自建转写服务，默认使用 AI Studio。 |
| 视频画面辅助 | 可提取带时间戳的画面拼图，与文字一起上传，图片提取默认关闭。 |
| 自定义提示词 | 可分别设置 ChatGPT 和 AI Studio 提示词，已有自定义内容优先于默认值。 |
| 后台处理 | 关闭扩展弹窗后任务继续，重新打开弹窗可查看进度或取消。 |
| 自动上传与发送 | 确认本次附件全部上传成功后自动发送，状态不明时停止，避免盲目重复上传。 |
| 书库联动 | 普通聊天可将视频链接、封面副本和私人 ChatGPT 对话链接保存到知行批注书库，需要兼容的书库扩展与 Native 数据中心。 |
| 独立设置 | 可与原版 B站总结扩展并存，两个扩展的设置和模型缓存分别保存。 |

### 内容如何到达 ChatGPT

```text
视频 → 优先提取已有字幕 ─────────────────────────┐
         │                                      │
         └─ 无字幕 → 获取音频 → 转写为 SRT ──────┤
                               │                │
                               ├─ AI Studio     │
                               ├─ 本地 Whisper  │
                               └─ 自建服务      │
                                                ↓
                               ChatGPT + 自定义提示词 → 整理笔记

图片提取·开 → 提取视频画面 → 带时间戳的拼图 → 随内容上传
```

- 例如，整理一段没有字幕的课程视频时，默认流程会把音频交给 AI Studio，待完整 SRT 逐字稿通过校验后，再自动交给 ChatGPT 整理。
- AI Studio 输出被截断、转写失败或任务被取消时，扩展不会继续交接，并保留 AI Studio 页面供检查。
- 最终笔记由 AI 服务生成，内容完整性与准确性仍需要对照原视频核查。

## 支持范围与当前状态

| 来源 | 已实现的处理方式 | 现有验证与限制 |
|---|---|---|
| B站 | 字幕、独立音轨、多分 P、稍后再看，以及可选画面拼图。 | 已有 Edge 初步正常的用户反馈，完整回归尚未全部完成。 |
| YouTube | 通过本机程序提取字幕，必要时回退到媒体下载和音频处理。 | 已验证字幕、完整音轨和短视频拼图提取，真实目标网页上传仍待完整验收。 |
| 抖音 | 优先读取当前作品的独立音轨，失败时回退原视频，开启图片后下载视频取帧。 | 已验证音轨完整性并有上传成功反馈，当前版本自动发送与后续交接仍待真实登录页面验收。 |

- 上表区分“已经实现”和“已经验证”，不代表这些平台上的所有视频都能成功处理。
- 视频可访问性、平台登录要求、下载限制，以及 ChatGPT / AI Studio 页面变化，都可能影响任务执行。
- 当前主分支版本以 [package.json](package.json) 和 [manifest.json](manifest.json) 为准，修订历史见 [CHANGELOG.md](CHANGELOG.md)。

## 快速开始

### 1. 加载扩展

```powershell
git clone https://github.com/severin-ye/VidSift.git
cd VidSift
```

1. 从本仓库下载源码 ZIP 并解压到固定目录，或用下面的命令克隆，找到包含 `manifest.json` 的 VidSift 文件夹。
2. 在 Chrome 打开 `chrome://extensions`，或在 Edge 打开 `edge://extensions`。
3. 开启开发者模式，选择“加载已解压的扩展程序”，选中该文件夹并按浏览器提示确认权限。
4. 核对名称为“知行视频总结”，并将它固定到浏览器工具栏。

- 扩展 ID 为 `kggdkncbamdlhhihfkeldbbkppkgihad`，可以保留原版扩展，无需卸载。
- 源码或可加载 ZIP 需要解压后加载，不是可直接安装的商店签名 CRX。
- 升级后若页面仍使用旧脚本，请重新加载扩展并刷新视频页及目标网页。

### 2. 按需安装本机程序

- **YouTube、抖音和图片提取需要本机程序**，只处理 B站已有字幕时可以先跳过此步。
- Windows 安装需要先安装 `uv`，并使用系统自带的 .NET Framework C# 编译器，前提与回退方法见 [INSTALL.md](INSTALL.md)。
- 在 VidSift 文件夹打开 PowerShell，执行：

```powershell
.\installer\Install-NativeHost.ps1 -ProjectRoot (Get-Location).Path
```

- 安装器会在 `%LOCALAPPDATA%\VidSift` 创建 Python 3.12 环境，安装媒体依赖，并注册 Chrome / Edge 的 Native Messaging 主机。
- 本机程序使用 yt-dlp、FFmpeg、youtube-transcript-api 和 Pillow 处理媒体，不会额外安装转写模型，也不是常驻 HTTP 服务。
- 安装完成后，在设置页点击“检测本机提取程序”，确认连接成功。
- macOS / Linux 暂无随项目提供的对应安装流程。

### 3. 开始第一次总结

1. 登录 ChatGPT；使用默认 AI Studio 转写时，也先登录 Google AI Studio。
2. 打开扩展“设置”，选择转写方式并检查两组提示词。
3. 返回视频页，先保持“图片提取·关”，点击弹窗中的提取或发送按钮。
4. 等待内容提取、必要的转写和附件上传完成，在 ChatGPT 中查看整理结果。

- **点击运行会触发自动上传和发送**，请先确认视频内容适合交给所选服务处理。
- 按钮文字会随字幕状态和转写方式变化，任务开始后可以关闭弹窗。

## 使用方式

### 选择转写方式

| 方式 | 音频在哪里处理 | 需要准备什么 |
|---|---|---|
| AI Studio（默认） | 上传至 AI Studio，生成完整 SRT 后交给 ChatGPT。 | 可访问并已登录的 AI Studio 和 ChatGPT 网页。 |
| 浏览器内 Whisper | 在浏览器内转写，所得 SRT 再发送到 ChatGPT。 | 首次需下载模型，以及所选推理方式需要的浏览器与硬件条件。 |
| 自建转写服务 | 发送到你配置的服务，转写结果再交给 ChatGPT。 | 在设置中填写 API 地址及服务需要的 Token。 |

- 浏览器内转写只改变语音识别的位置，后续总结仍会把文字发送到 ChatGPT。
- 本地模型保存在此扩展的浏览器缓存中，不会自动与原版共享。

### 自定义整理方式

- ChatGPT 默认提示词用于深度理解和结构化总结，可以按需要改成课程笔记、论证梳理或操作步骤。
- AI Studio 默认提示词用于生成带绝对时间戳的完整 SRT，修改时请保留完成校验需要的格式和完成标记。
- 两组提示词可以分别保存和恢复默认，恢复某一组不会覆盖另一组。
- 弹窗还提供临时对话和后台打开选项，AI Studio 转写页按既有流程在后台打开。

### 音频大小与后台打开

- 设置页可单独保存/恢复音频参数，默认AAC 64 kbps、单声道，来源音轨目标64 kbps；优先保留完整口播和原声语言。
- 平台有多种完整音轨时优先选择较小来源；只有单一完整音轨时，压缩只能减少上传大小，不能声称下载量同步减少。
- 本机压缩检查全长，默认不变更采样率；原B站浏览器音轨流程继续选最小带宽，不强制改走本机。
- 同一821秒抖音样本由13,545,027字节压为6,799,130字节，时长差小于0.01秒；尚未比较转写准确率。
- “GPT后台打开”只控制最终GPT页面是否切到前台；AI Studio转写阶段始终后台打开，关闭弹窗后任务仍继续。
- 附件采用分块传输后一次提交，避免抖音现代路径重复携带base64音频并超过浏览器64 MiB消息限制；旧目标页脚本会提示重新从视频页发起。
- 隔离Edge已验证27/60 MiB附件逐字节一致和单次上传/Run；实际登录AI Studio与GPT接力仍待验收。

### 知行批注书库联动

- 普通聊天默认自动保存视频链接、封面副本和对应的私人ChatGPT对话链接；只存信息卡片，不存总结正文、字幕或音频。
- 临时聊天默认关闭；已有明确保存的临时聊天选择仍保留，开启时完全不入书库。
- 需要同时更新知行批注书库扩展及其Native数据中心，书库新增视频类型和全部/有批注/无批注筛选；有划线或文字均算有批注，删掉最后批注不会删除视频卡片。
- 每个ChatGPT对话保留独立记录，同视频再次总结不会覆盖旧链接；相同对话的重试不重复建卡片。
- 发送确认并取得有效对话链接后建立记录，不据此宣称ChatGPT已完成生成；原对话访问权限仍取决于原账号，不创建公开分享链接。
- 设置页的书库联动块可单独开关、修改书库扩展ID、恢复本块默认、查看状态和重试；失败保留本地待办，不重发总结。封面缺失明确显示，待办保留以便后续补齐。
- 默认书库ID为`ajjcbhalcgpmelnmlnheefbfikdgmjdp`，适用于当前既有安装；其他安装可从扩展管理页复制实际ID。不开启额外常驻服务或历史扫描。
- 协议与保护边界见[设计原稿](设计对齐稿/视频总结与书库联动/2026-11-10%20视频总结自动入库.md)，实现与安装证据见[实施记录](docs/superpowers/plans/2026-11-10-video-library.md)；源码不代表日常浏览器已加载。

### 同时参考视频画面

- 开启“图片提取·开”后，本机程序会抽取画面并生成带时间戳的拼图。
- 默认按场景变化选帧，无有效候选或检测失败时回退到间隔截图，场景变化检测不理解画面语义。
- 默认间隔 5 秒，每张拼图最多 3 × 3 格，最多 15 张，即最多 135 个画面，末张可以不足九格。
- 视频较长、超出容量时会自动增大间隔以覆盖全程，因此拼图不能代替逐帧观看。
- 提取方式、间隔、拼图数量和画质等参数可以调整，并可单独恢复图片提取默认设置。
- 关闭图片后，不会为了截图下载视频或抽帧，但无字幕时仍可能下载必要音频或原视频。

### 查看进度与取消

- 在视频页或本任务的 AI Studio / ChatGPT 页重新打开扩展，可查看任务阶段并取消。
- 视频页不显示进度浮窗，关闭弹窗不会取消任务。
- 来源切换或取消会触发相应防护，扩展不会把已判定失效的任务继续交接给 ChatGPT。

## 隐私与权限

- 提示词、图片设置和转写配置保存在此扩展的浏览器存储中，自建服务 Token 也保存在该存储中。
- 开启书库联动时，视频链接、封面副本和私人 ChatGPT 对话链接还会保存到本机知行批注书库，临时聊天不入库。
- 字幕、转写文本及所选图片会发送到 ChatGPT，AI Studio 路径会向 Google 发送音频，自建路径会向配置的服务发送音频和认证信息。
- 本地 Whisper 首次下载模型需要访问模型分发服务，完成本地转写后仍按任务设置上传文字。
- 本机临时文件会在任务完成、取消或进程正常结束后清理，异常退出可能留下临时目录。
- 最近一次网页交接的阶段、版本、时间和任务标识保存在本地用于排障，该记录不含音频、提示词或账号凭据。
- 扩展没有开发者运营的数据收集服务器，各平台和 AI 服务分别适用自身的数据处理规则。

| 权限 | 用途 |
|---|---|
| `activeTab` / `tabs` | 识别当前视频、打开目标页并管理任务标签页。 |
| `storage` | 保存提示词、设置和任务诊断状态。 |
| `scripting` | 在已授权页面补载缺失的内容脚本。 |
| `offscreen` | 支持浏览器内转写处理。 |
| `nativeMessaging` | 与本机媒体程序通信。 |
| 站点访问权限 | 提取平台内容并向 AI 网页交接，自建服务按配置申请额外权限。 |

- 完整说明见 [PRIVACY_POLICY.md](PRIVACY_POLICY.md)，实际权限声明见 [manifest.json](manifest.json)。

## 常见问题

### 点击运行后为什么还没有总结？

- 无字幕视频需要先获取音频并转写，AI Studio 路径还要等待完整逐字稿通过校验。
- 重新打开扩展查看当前阶段，再检查对应网页是否登录、附件是否上传成功或生成是否截断。
- 上传或发送状态不明确时先查看目标页，避免重复点击产生相同任务。

### 为什么提示找不到本机程序？

- 先确认运行了本包安装脚本，再在设置页检测本机程序，排查和回退方法见 [INSTALL.md](INSTALL.md)。
- 旧测试程序若登记了不同的扩展 ID，需要使用本包脚本重新安装。

### 为什么有的视频提取失败？

- 平台要求登录、媒体地址失效或下载受限时可能失败，请先确认视频在浏览器中能正常播放。
- 反馈时请附平台、扩展版本、转写方式、失败阶段与错误提示，并去除敏感内容。

### 能否完全离线总结？

- 当前工作流依赖 ChatGPT 网页，浏览器内 Whisper 只负责本地转写，不能让整个总结流程离线运行。

## 源码仓库与父工作区

- 本项目独立维护于 [severin-ye/VidSift](https://github.com/severin-ye/VidSift)，默认分支为 `main`，修改源码和提交 Pull Request 请以此仓库为准。
- Codelib-severin 父工作区在 `2_Business/VidSift` 使用 Git 子模块，只记录独立仓库的提交指针与 `.gitmodules` 配置。
- 在父工作区根目录执行下面的命令，可取得父仓库记录的确切版本，而不是自动切到独立仓库最新版本。

```powershell
git submodule update --init -- 2_Business/VidSift
```

- 后续更新先在独立仓库提交并推送，再在父仓库提交新的子模块指针，父仓库原有源码历史继续保留。

## 开发与贡献

- 扩展采用 Manifest V3，界面和内容脚本使用 JavaScript / HTML / CSS，本机媒体程序使用 Python。
- 开发检查需要 Node.js 与 npm，浏览器测试使用 Playwright，Windows 打包使用 PowerShell。
- 在包含 `package.json` 的 VidSift 目录执行：

```powershell
npm ci
npm run check

# 浏览器流程测试，使用隔离环境
npm run test:browser
npm run test:edge

# 本机程序测试，需要先准备 Python 依赖
python -m pip install -r requirements-native.txt
python -m unittest discover -s tests/native -v

# Windows：生成可解压加载的扩展 ZIP
npm run package
```

- `npm run check` 检查语法、扩展资源、版本一致性及 Node.js 测试，不代表真实登录网站流程已经通过。
- `npm run test:browser` 可通过 `VIDSIFT_BROWSER_EXE` 指定 Chromium，`npm run test:edge` 需要已安装 Edge。
- 设置 `VIDSIFT_ORIGINAL_EXTENSION` 指向原版 4.12.0 解压源码，可验证并存及设置隔离，测试不使用日常浏览器数据。
- `package.json` 是版本来源，修改版本后用 `npm run version:sync` 同步 manifest，打包结果输出到 `dist/`。
- `.task-artifacts/` 保存任务下载、隔离浏览器配置与验证证据，不进入 Git 或分发包。
- 欢迎提交 Issue 或 Pull Request，请说明复现步骤、预期和实际结果，并去除 Token、Cookie、私人视频等敏感信息。

| 目录或文件 | 职责 |
|---|---|
| `background.js` / `background-video.js` | 后台任务与视频处理流程。 |
| `popup.*` / `options.*` | 扩展弹窗与设置页。 |
| `*-content.js` | 视频平台与 AI 网页的内容脚本。 |
| `native/` / `installer/` | 本机媒体程序与 Windows 安装、回退脚本。 |
| `tests/` | 扩展逻辑、本机程序和浏览器流程测试。 |
| `scripts/` | 版本同步、资源检查与打包脚本。 |

## 开源协议与致谢

- VidSift 采用 [MIT License](LICENSE)，分发时请保留许可证及原作者署名。
- 项目基于 [ayanamist/bilibili-subtitle-to-chatgpt](https://github.com/ayanamist/bilibili-subtitle-to-chatgpt) 改造，保留原版的字幕处理、提示词设置和网页交接基础。
- 本机媒体处理参考了 [JefferyHcool/BiliNote](https://github.com/JefferyHcool/BiliNote)，采用内容与许可记录见 [native/THIRD_PARTY.md](native/THIRD_PARTY.md)。
- 第三方来源说明见 [THIRD_PARTY.md](THIRD_PARTY.md)，原版 README 见 [docs/README.upstream.md](docs/README.upstream.md)。
