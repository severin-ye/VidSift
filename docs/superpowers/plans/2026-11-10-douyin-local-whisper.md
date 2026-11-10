# 抖音浏览器本地转写 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for coordination and bounded workers for independent implementation; user has approved immediate implementation, so no further routine plan approval is needed.

**Goal:** 实测两个量化中文模型并选择最小合格模型，完成抖音取音频→浏览器转写→GPT总结的真实流程。

**Architecture:** 复用Native媒体获取，用FFmpeg按时间窗口提供16kHz单声道PCM；浏览器可终止worker运行现有Transformers.js q8，分块持久化结果。抖音独立转写设置不改变B站与YouTube既有设置。

**Tech Stack:** Chrome MV3/Edge、Transformers.js3.8.1、ORT、Python Native Messaging、现装FFmpeg。

**Spec:** ../../../设计对齐稿/抖音本地转写/2026-11-10 抖音总结修复设计.md；2026-11-10本聊天用户明确批准，要求先比较77MB/base与249MB/small两个q8模型。

## Global Constraints

- 沿用独立ID与最新正式名称；保护已有设置、GPT提示词、临时聊天和书库。
- 所有中文质量结论必须指明样本/参照；结构通过不等于内容正确。
- 默认音频最长60分钟、源单文件512MiB；最初2GiB内存目标被实测small约4.0GiB浏览器总工作集反证，改为6GiB启动预估准入值并明确没有进程硬限额；可调值在设置，强制校验不可关闭。
- 使用现有共享媒体/模型资产目录，升级复用；失败24h/成功1h媒体保留、总限1GiB，活动租约不淘汰。
- 无用户请求不自动把本地失败转为AIStudio上传；发送已确认与总结已生成区分。

## Review Focus

- 取消、作品切换及worker迟到回复不触发GPT发送。
- service worker重启后只恢复状态，不能自动重发。
- 现有Native旧调用兼容，新窗口协议对旧host明确报版本问题。
- 长音频推理窗口按绝对时间拼接；静音不补字幕，缺块不得发送。
- 原全局设置保留；仅缺失抖音专用值迁移为local，后续升级不覆盖显式值。

### Task 1: 两模型实测与选择

**Files:** .task-artifacts/model-benchmark/*（私有，不提交）；docs/中文模型对比-2026-11-10.md（只提交摘要）。
**Interfaces:** 产出模型ID、revision、dtype、backend、准确性证据、纯推理耗时、冷/热加载及实际字节。
- [ ] 用相同首/中/尾片段实际运行base/small q8，分离下载/加载与推理时间。
- [ ] 以已知中文文本或独立可核验字幕作质量参照，记录错误和未验证项；按不遗漏关键句/论点的标准选择最小模型。
- [ ] 模型和运行时代码只下载一次，交接共享资产路径供后续使用。

### Task 2: Native有界PCM窗口与缓存租约

**Files:** native/host.py、native-client.js、tests/native/test_local_audio.py、tests/native-client.test.js。
**Interfaces:** prepare_local_audio(assetId,videoId,settings)返回fingerprint/duration/sampleRate；read_pcm_window(fingerprint,start,duration)以既有小于1MiB分片消息返回float32 PCM；保留/释放租约与校验缓存指纹。
- [ ] 先写RED：窗口时间边界、身份/路径校验、读取长度、取消、重开连接缓存复用、过期/配额与活动租约保护。
- [ ] 实现按时间FFmpeg解码，避免整段base64；本地取原音轨不做无必要AAC重编码，旧上传路径保持。
- [ ] 验证同一媒体多窗口、短尾块和Native协议整链，保留完整日志。

### Task 3: 本地worker和可靠转写

**Files:** local-transcription.js、whisper-worker.js、offscreen.js、offscreen.html、background-video.js、task-diagnostics.js、tests/local-transcription.test.js。
**Interfaces:** LocalTranscription.start({taskId,source,model,device,duration,readWindow,signal,onProgress})→SRT；cancel终止worker、缓存已完成块，retry核验指纹后复用。
- [ ] RED验证排队、单实例、GPU→WASM显式回退、取消、旧消息隔离、静音、时间戳/覆盖范围及断点恢复。
- [ ] 打包JS/WASM；首次自动准备模型并显示进度，热缓存离线复用；量化精度由实测确定。
- [ ] 整个PCM只保留当前/下一窗口，窗口结果按绝对时间去重拼接，全部块完成才输出SRT。

### Task 4: 设置、流程与兼容性

**Files:** video-workflow.js、popup.js、options.js/options.html、manifest.json、scripts/Package.ps1、tests/video-workflow.test.js、tests/local-settings.test.js。
- [ ] RED验证抖音新字段缺失默认local、跟随全局、既有显式选择保留，其他平台及提示词/书库设置不变。
- [ ] 接通Native窗口→worker→GPT，记录各阶段具体失败原因；设置块单独保存/恢复。
- [ ] 更新现有缓存占用/清理与参数入口，取消/错误不重发GPT。

### Task 5: 真实流程、交付和整合

**Files:** README/INSTALL/CHANGELOG、版本派生、设计索引、安装记录；私有.task-artifacts证据。
- [ ] 运行npm run check、Native测试、受控真实Edge回归；只重验受影响检查。
- [ ] 5分钟与33分钟音频全程，抽听首个有效语音、中点、尾部各30秒；GPU/WASM、冷/热缓存及取消/重启分别记录。
- [ ] 保护升级状态与回退后更新原加载目录/Native；真实Edge抖音点击至GPT非空回复结束，普通聊天书库卡片与临时聊天隐私核验。
- [ ] 独立审查本次状态流、修复必要问题，中文提交→main整合→推送与远端核验；不得凭模拟结果宣布完成。

## 执行记录

- 2026-11-10：用户明确要求开始，无需再次审批本计划；首个模型实测正在进行，尚无模型质量或提速结论。
