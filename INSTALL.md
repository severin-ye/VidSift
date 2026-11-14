# 安装知行视频总结（VidSift）

## 普通用户：下载 ZIP 并加载

1. 打开[最新版下载页](https://github.com/severin-ye/VidSift/releases)，下载最新一条发布记录 **Assets** 中的 `VidSift-版本号-standalone.zip`，不要选择 `Source code`。
2. 将 ZIP 全部解压到固定文件夹，找到 `manifest.json` 所在位置。
3. 打开 Chrome 的 `chrome://extensions` 或 Edge 的 `edge://extensions`，开启“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择包含 `manifest.json` 的文件夹，按浏览器提示确认权限。

- 浏览器加载的是解压后的文件夹，不能直接把 ZIP 当作商店安装包打开。
- 这条安装路径不需要 Git、Node.js、npm 或从源码构建。
- 仅使用 B站已有字幕时，到此即可打开视频并使用扩展；YouTube、抖音及图片提取还需要下方的本机程序。

## 升级与并存

- 先把ZIP解压到固定目录，例如 `%LOCALAPPDATA%\VidSift\extension`；不要从临时解压目录加载。
- 在Chrome的 `chrome://extensions` 或Edge的 `edge://extensions` 中，按浏览器提供的开发者加载流程选择“加载已解压的扩展程序”，选择包含 `manifest.json` 的目录；需要的浏览器权限由用户在界面确认。
- 核对名称知行视频总结、版本与所下载发布包一致、ID `kggdkncbamdlhhihfkeldbbkppkgihad`；原扩展可以保留，不需要卸载、关闭或替换。
- 两扩展同时启用时各自响应各自弹窗；执行任务时只操作其中一个弹窗，以免人为启动两个相同任务。
- 从5.0.2起使用 `scripting` 权限，在已授权视频页或目标网站补载缺失脚本并读取当前作品资源；如浏览器要求确认，请在扩展管理页确认后重新加载，并刷新视频页。

- 从5.11.3起，长音轨上传前按整段时长选择压缩码率并核对全长；本机程序须同步更新到5.11.3，旧Native5.8.0仍使用固定64kbps，45分钟等长音轨可能继续超限失败。现有Groq密钥、原音轨、FFmpeg和模型缓存保留。

- 从5.8.0起，三个平台无字幕时默认用Groq；须同时更新本机程序到5.8.0，以支持B站和YouTube的完整音轨描述符；现有Groq密钥、FFmpeg和缓存继续保留。

- 从5.7.0起，无字幕的 B站后台音频处理也复用本机程序，以便关闭源视频页后继续；已有字幕且关闭图片提取时仍不需要本机程序。5.7.0阶段可复用5.5.0；升级5.8.0时须按上条更新本机程序。

- 从5.0.x升级到5.1.x时同时运行本包安装器更新Native，才能应用音频设置；已有Native5.1.0可继续使用5.1.1扩展，复用FFmpeg与依赖下载缓存，不安装转写模型。

- Groq密钥输入和安全保存需要更新Native至5.5.0；安装器保留回退并复用已有依赖和模型资源，旧Native5.4虽能转写但不能保存新密钥。
- 安装器复用FFmpeg与依赖缓存；Groq不下载本地模型，已有本地模型缓存保留，仅在显式选择本地转写时使用。
- 正常运行需要Groq转写时，缺少密钥会弹窗，可在弹窗下方打开申请页面，输入后点“保存并继续”；也可从设置页“填写API Key”打开入口，不需要再手工编辑`.env`。
- 新密钥验证后保存到 `%LOCALAPPDATA%\VidSift\runtime\credentials\groq.dpapi`，仅当前Windows用户可解密；不进入扩展设置/同步或安装包。已有环境变量与个人`.env`仍优先，不会被覆盖；不要把密钥填进源码或发到聊天，无需开启付费计划。
- 回退Native5.4时新密文文件仍保留，但旧版不能读取新保存方式；原`.env`仍有效，首次只用弹窗配置的用户回退后需手工配置`.env`，不会自动写出明文。
- 安装后在“抖音转写”检测Groq配置，选择Groq与turbo模型；既有明确选择继续保留，不改变B站/YouTube设置。

## 安装本机程序（YouTube、抖音、图片处理所需）

- Windows安装脚本需要 `uv` 和系统自带 .NET Framework C# 编译器；如果尚未安装uv，请从其官方发行渠道安装后再运行。
- 在解压目录打开PowerShell，执行：

```powershell
.\installer\Install-NativeHost.ps1 -ProjectRoot (Get-Location).Path -Version (Get-Content .\package.json -Raw | ConvertFrom-Json).version
```

- 脚本在 `%LOCALAPPDATA%\VidSift` 创建独立Python 3.12环境、安装yt-dlp/youtube-transcript-api/Pillow，复用或获取FFmpeg，并注册当前用户的Chrome/Edge Native Messaging主机 `com.vidsift.media`。
- 运行资源位于 `runtime`，版本程序位于 `releases\<版本号>\native\<安装ID>`，激活配置为 `runtime\current.json`；安装回执和回退文件保存在 `backups\native-<时间与ID>\rollback.json`。
- 只允许当前独立VidSift的扩展ID连接；不是常驻HTTP服务，没有开机启动项，任务结束即退出。
- 安装完成后，在VidSift设置页点击本机程序检测；如果以前装过测试用本机程序，需使用本包脚本再安装一次以更新允许的独立扩展ID。
- `VIDSIFT_FFMPEG` 可指向已有FFmpeg；媒体提取不需要API Key，Groq转写需要按上文配置；自建转写地址和令牌仅在扩展自己的设置页填写，不写进源码。
- 回退本机程序时，使用安装输出的实际回执路径：

```powershell
.\installer\Rollback-NativeHost.ps1 -Receipt '实际的rollback.json路径'
```

- 原浏览器扩展设置和缓存不会由这些脚本迁移；独立扩展的浏览器模型缓存也不会与原版自动共享。

## 验证范围

- 本包检查扩展身份、资源、版本、设置隔离、附件协议、取消与来源切换防护以及截图数量与时间排序。
- 安装到实际Chrome/Edge、真实视频与目标网页上传仍需实站验收，打包成功不代表这些流程已经通过。
- 安装器保留每次安装的旧环境和回退条件；不要手动覆盖浏览器商店的扩展文件或修改浏览器安全设置来跳过加载确认。
