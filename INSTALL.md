# 安装独立知行视频总结（VidSift）

- 先把ZIP解压到固定目录，例如 `%LOCALAPPDATA%\VidSift\extension\5.2.2`；不要从临时解压目录加载。
- 在Chrome的 `chrome://extensions` 或Edge的 `edge://extensions` 中，按浏览器提供的开发者加载流程选择“加载已解压的扩展程序”，选择包含 `manifest.json` 的目录；需要的浏览器权限由用户在界面确认。
- 核对名称知行视频总结、版本5.2.2、ID `kggdkncbamdlhhihfkeldbbkppkgihad`；原扩展可以保留，不需要卸载、关闭或替换。
- 两扩展同时启用时各自响应各自弹窗；执行任务时只操作其中一个弹窗，以免人为启动两个相同任务。
- 从5.0.2起使用 `scripting` 权限，在已授权视频页或目标网站补载缺失脚本并读取当前作品资源；如浏览器要求确认，请在扩展管理页确认后重新加载，并刷新视频页。

- 从5.0.x升级到5.1.x时同时运行本包安装器更新Native，才能应用音频设置；已有Native5.1.0可继续使用5.1.1扩展，复用FFmpeg与依赖下载缓存，不安装转写模型。

## 安装本机程序（YouTube、抖音、图片处理所需）

- Windows安装脚本需要 `uv` 和系统自带 .NET Framework C# 编译器；如果尚未安装uv，请从其官方发行渠道安装后再运行。
- 在解压目录打开PowerShell，执行：

```powershell
.\installer\Install-NativeHost.ps1 -ProjectRoot (Get-Location).Path
```

- 脚本在 `%LOCALAPPDATA%\VidSift` 创建独立Python 3.12环境、安装yt-dlp/youtube-transcript-api/Pillow，复用或获取FFmpeg，并注册当前用户的Chrome/Edge Native Messaging主机 `com.vidsift.media`。
- 运行资源位于 `runtime`，版本程序位于 `releases\5.2.2\native\<安装ID>`，激活配置为 `runtime\current.json`；安装回执和回退文件保存在 `backups\native-<时间与ID>\rollback.json`。
- 只允许当前独立VidSift的扩展ID连接；不是常驻HTTP服务，没有开机启动项，任务结束即退出。
- 安装完成后，在VidSift设置页点击本机程序检测；如果以前装过测试用本机程序，需使用本包脚本再安装一次以更新允许的独立扩展ID。
- `VIDSIFT_FFMPEG` 可指向已有FFmpeg；不需要新增API Key；自建转写地址和令牌仅在扩展自己的设置页填写，不写进源码。
- 回退本机程序时，使用安装输出的实际回执路径：

```powershell
.\installer\Rollback-NativeHost.ps1 -Receipt '实际的rollback.json路径'
```

- 原浏览器扩展设置和缓存不会由这些脚本迁移；独立扩展的浏览器模型缓存也不会与原版自动共享。

## 验证范围

- 本包检查扩展身份、资源、版本、设置隔离、附件协议、取消与来源切换防护以及截图数量与时间排序。
- 安装到实际Chrome/Edge、真实视频与目标网页上传仍需实站验收，打包成功不代表这些流程已经通过。
- 安装器保留每次安装的旧环境和回退条件；不要手动覆盖浏览器商店的扩展文件或修改浏览器安全设置来跳过加载确认。
