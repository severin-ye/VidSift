# 来源与许可

- 主干：[ayanamist/bilibili-subtitle-to-chatgpt](https://github.com/ayanamist/bilibili-subtitle-to-chatgpt)，基线 `218400395f7a072a0d6bca0cc76d8ff34c58abb9`，原 README 声明 MIT；原有作者署名与代码注释保留。
- 媒体处理参考：[JefferyHcool/BiliNote](https://github.com/JefferyHcool/BiliNote)，MIT，Copyright (c) 2024 Jeffery Huang；具体说明及许可全文在 [native/THIRD_PARTY.md](native/THIRD_PARTY.md)。
- 本机依赖 yt-dlp、youtube-transcript-api、Pillow 由运行环境安装，遵循各自分发许可；FFmpeg 的来源、版本和许可随安装回执保留。
- `lib/` 的 Transformers.js 与 ONNX Runtime 文件沿用原项目的版本和来源说明，不包含用户模型缓存。
- 没有引入 ExtractSubtitles、DySub、video-summarizer 的代码。
# 本次本地转写运行时

- 随包附带的 `lib/ort-wasm-simd-threaded-3.8.1.jsep.wasm` 来自官方 `@huggingface/transformers@3.8.1` 分发，匹配现有 JS/MJS，按 ONNX Runtime 的 MIT 许可使用；不在用户运行时下载可执行代码。
- 量化 Whisper 权重来自 [Xenova/whisper-base](https://huggingface.co/Xenova/whisper-base) 与 [Xenova/whisper-small](https://huggingface.co/Xenova/whisper-small)，上游 OpenAI Whisper 采用 MIT 许可；实际修订与大小见 [中文模型对比](docs/中文模型对比-2026-11-10.md)。权重按需作为数据下载，不随扩展包复制。

