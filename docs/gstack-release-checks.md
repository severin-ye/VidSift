# 发布检查与原生交付

本项目由个人 AGENTS、Skill 与 Router 主导协作；所选发布通用检查由已安装 gstack 的 `gstack-evidence run --reuse` 执行，并立即用明确 label 与 `--expect-cmd` 调用 `check`。项目脚本不维护第二套成功凭据或重试策略；不提供缺失工具时直接检查的旁路。gstack 的工作树、命令、环境及有效期规则决定复用，未知测试数量等情况可能重跑。

Windows 调用边界为 `scripts/gstack-check.ps1`，默认使用 `%USERPROFILE%/.codex/skills/gstack/bin/gstack-evidence` 和 PATH 中的 Bun；`GSTACK_EVIDENCE` 可显式指定另一个已安装工具位置，不会下载或修改 gstack。PowerShell 子命令经 EncodedCommand 传递以保护路径/引号，命令身份因此包含其完整编码；这不是隐藏凭据，通用检查不得在命令中插入秘密。

`npm run release` 的 `npm run check` 由 label `vidsift-release-check` 管理；`npm run check` 本身仍是人工可用的直接诊断命令，不作为发布成功凭据。发布入口仍要求 clean main、版本/tag、原生包契约、可重复 ZIP、上传后下载 SHA256 核验及旧资产安全处置；包测试保持原生验收，不由通用测试成功替代。

适配器定向验收：`powershell -NoProfile -File tests/gstack-release.test.ps1`；加 `-Integration` 仅在任务独立工作副本创建 `.agent-status/gstack-adapter-fixture` 小型 Git/Bun 夹具，验证真实 evidence 成功、复用与失败阻断，禁止在正式安装目录运行。夹具和账本不进 Git，复核后由创建者清理。

源码工具回归、应用测试、原生构建、安装、实际数据/站点验收与远端 CI 是不同证据；只通过适配器测试不证明应用已发布或可安装。
