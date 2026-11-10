# 视频总结与书库联动 Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development or superpowers:executing-plans for bounded implementation.

**Goal:** 普通视频总结自动保存三项信息卡片，并在知行书库按有无批注筛选。

**Architecture:** VidSift构造有界元数据和封面，经受限外部消息交给书库；书库独立保存视频记录，复用现有共享中心及批注查询。主对话负责最终集成、安装和Git收尾。

**Tech Stack:** Chromium MV3 JavaScript、TypeScript/IndexedDB、Python SQLite Native Messaging。

**Spec:** [设计原稿](../../../设计对齐稿/视频总结与书库联动/2026-11-10%20视频总结自动入库.md)。

## Global Constraints
- 不保存总结正文；临时聊天不入库；活跃高亮或文字均属于有批注。
- 书库对话UUID是幂等身份；不得覆盖其他对话、删除批注、清空配置或改扩展身份。
- 消息、字段、来源白名单及图片大小见设计原稿固定协议。
- 保留原数据和失败证据；仅主对话合入主线、推送及安装。

## Review Focus
- 服务工作线程重启及应答丢失后，待办仍可幂等重投。
- 删掉最后批注或关闭某个扩展不能删除视频记录。
- 临时聊天即使出现普通URL也不能排队入库。
- 图片类型、尺寸、URL及发送者不能越过固定边界。
- 旧共享客户端不能清除新视频类别；能力不足必须明确降级。

### Task 1: 书库接收、持久化和筛选
Files: web-notes/src/shared视频模型与db相关文件；src/background/index.ts；src/library；manifest.json；适用native协议及测试。
Interfaces: consumes固定v1外部消息；produces三项卡片、动态批注过滤、local durable ack。
- [x] 写失败用例：零高亮入库、筛选、幂等、删除批注后存在、非法请求拒绝。
- [x] 复用事务/outbox/Native通道实现视频记录和备份共享，测试旧数据往返。
- [x] 增加同书库的视频卡片和全部/有批注/无批注筛选，保持旧网页/HTML能力。
- [x] 跑聚焦TS/Python用例与构建，更新文档、版本及变更记录，任务分支提交。

### Task 2: VidSift生成交接和待办恢复
Files: video-library.js、background.js、chatgpt-content.js、popup.js、options页面、manifest、平台封面及测试。
Interfaces: produces与Task1相同v1消息；受限图片数据URL；保存失败不触发重新总结。
- [x] 写失败用例：持久会话URL、临时跳过、稳定ID、发送重试及图片限制。
- [x] 在成功发送后获取正确会话URL交接；补齐视频源上下文与封面。
- [x] 默认普通聊天，独立设置块和状态/重试入口，持久待办有界且可恢复。
- [x] 运行npm run check及native必要用例，更新README/版本/变更记录。

### Task 3: 主对话集成与交付
- [x] 真实隔离Chromium加载两个最终扩展，验证外部消息、零批注卡片、批注筛选、重试和临时排除。
- [ ] 审查两仓差异及状态保护，核对实际加载目录/Native协议和备份，在当前授权内执行本地更新。
- [ ] 运行必要升级验收；未执行/失败项如实记录，不冒称真实站点已通过。
- [ ] 提交、合入各仓main、推送及远端核验；保存交付链接和用户可用入口。

## 本次实际验证与交付状态
- VidSift发送端、书库3.4.0接收端已实现；两扩展在隔离Edge以合成站点真实消息交接通过。
- 真实中心25MB一致性副本包含8333条原记录；新增video后全部原记录逐项相等，完整备份往返通过；不向正式中心写测试数据。
- 独立审查发现并修复B站分P丢失、旧对话URL错绑、缺封面待办饥饿；新增定向用例。
- 日常电脑操作工具因无法可靠识别当前浏览器网址而停止，未绕过该限制；两扩展和Native未正式更新，用户当前5.1.1/3.3.1保持原状。
- 旧构建与中心的一致性备份保存在本任务私有状态目录，未上传；真实登录态视频生成与日常加载/共享验收未完成。

- 最终发送端139项测试通过；书库全测及Native必要用例见同仓验证文档；独立审查的缺图容量问题以25条无封面连续保存用例验证，已保存卡片不再挤占未保存容量。
- 源码交付与正式安装分开；候选包可复现构建，但不能据此宣称正式环境已联动。
