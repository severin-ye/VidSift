# 总结伴播归档

- 状态：已放弃，非正式可用功能，不继续开发、不合入主线、不发布。
- 来源：2026-11-13 用户明确要求“把现在实现的提交一下”“准备不要这个功能了”“直接用 git 的方式把现在已有的这些实现作为一个归档”。
- 原实现：`c7bec2d` 增加普通后台标签页伴播；本次归档之前的完整源码快照为 `305c0e28423fedc7a2f7ee5ac408f32afefca140`。
- 本分支保留当时的运行源码、设置、测试、设计及以下隔离原型，供以后按需查看；主线没有接收总结伴播功能。

## 保留了什么

- 仓库根目录的 `bili-companion.js`、`bili-companion-content.js`、`background-bili-companion.js`、`options-companion.js` 及对应接线、测试，是已安装过的5.10.0候选实现。
- `probes/probe.cjs` 是官方外链播放器普通iframe的可行性探针。
- `probes/offscreen-full-probe.cjs` 是无COEP/COOP条件下，不新增窗口或标签页的后台完整播放原型。
- `probes/offscreen-coep-probe.cjs` 保存与生产页面隔离设置相同条件下的反例。
- 只归档自行编写的原型代码及公开事实摘要；账号、浏览器配置、Cookie、字幕、媒体、书库、诊断原始数据和下载的第三方脚本均不提交。

## 实际结果和未完成项

- 普通后台标签页方案经过330项Node回归、11项诊断测试及受控浏览器测试，但用户真实验收失败：播放/历史未达目标，并且多余页面或播放行为干扰使用。
- 本机最后伴播状态记录为“伴播页已由用户接管”；不能据此断言用户主动接管。
- 官方外链播放器及无COEP/COOP的offscreen原型，在未登录隔离Edge中真实静音播完约137秒视频；官方自身结束心跳包含`played_time=-1`、`realtime=136`、`real_played_time=136`、`outer=1`，没有伪造上报。
- 使用生产相同的`COEP=require-corp / COOP=same-origin`时，原型未观察到播放或心跳；准确拦截错误码未知。
- 已登录账号完整历史入账、不同分P、与现有本地Whisper转写的共存没有验收通过；不能把原型播放成功当作产品已完成。
- 用户曾选择无窗口方向并接受本地Whisper兼容调整可能变慢，但随后取消整个功能；无窗口生产接入和本地Whisper兼容修改尚未实施。

## 查看与恢复边界

- 原型不自动运行，不由正常产品入口加载，也不随安装包新增部署。
- 如需重跑探针，先复制到独立任务私有目录并准备Playwright；脚本会创建临时隔离浏览器和探针扩展，不应用于日常浏览器配置。
- 官方参考：[外链播放器说明](https://player.bilibili.com/)、[Chrome offscreen文档](https://developer.chrome.com/docs/extensions/reference/api/offscreen)。
- 日常候选撤回与本地证据位置由原任务的`.agent-status/bili-companion-1113.md`记录；以后恢复开发须重新核对平台行为和用户目标。
