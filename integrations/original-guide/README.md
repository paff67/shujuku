# 原著指导原生 LLM 桥接

数据库是纪要的唯一正式后端。填写进入 `processUpdatesBatch_ACU` / `executeCardUpdateCore_ACU`，召回进入 `runPlotTasksRuntime_ACU`；提示词、解析、纠错与提交由原生流程负责。卡保留原著推进、MVU、轮回身份和完整存档编排。

## 本地转换

```powershell
$env:ORIGINAL_GUIDE_SOURCE = '<已核对的原始脚本绝对路径>'
node scripts/convert-original-guide-native-llm.mjs
node --check integrations/original-guide/live-current-script-native-llm.js
```

工具使用 TypeScript AST 定位唯一管理器及旧协议函数，检查输入 SHA-256，保留业务提示词并升级存档编排。输入文件不被修改；摘要改变时默认拒绝，必须先审查差异。`ALLOW_SOURCE_HASH_CHANGE=1` 仅用于审查后的新版本。

完整生成卡和 manifest 是本地产物，已加入 `.gitignore`，不可强制提交个人卡正文。仓库仅保存桥接、转换工具、说明和数据库实现。manifest 只含文件名及摘要，不记录本机绝对路径；相同输入可以重复生成相同产物。

## 接入与配置

先加载配套数据库构建，再加载转换卡，API 为 `AutoCardUpdaterAPI.memory` v2。卡首次读取时绑定当前书籍和纪要表，通过原生聊天设置服务选择 `llm`；已有未映射行须先提供明确节点。自动填写只由数据库调度，卡按钮是明确的补齐请求。

纪要表必须有稳定 `row_id`，以及编码、时间、概览和正文列；支持真实中文表头和 DDL 物理列。语录列可选，旧档迁移到无语录列模板时将语录保留在正文。绑定时把默认业务规范保存到表的 Note，用户可在数据库中编辑，卡不维护第二份填写/召回主提示词。

当前聊天须启用剧情任务，选中能独立导出原生 `<recall>` 标签和 AM 编码的预设。剧情建议不会作为历史事实注入。召回使用用户的有效任务/提示词及 API 预设；宿主 `generateRaw` 不能隔离实时角色和世界书，此桥接要求数据库独立 custom API 的 URL 与模型。配置不兼容时明确阻断，不回退交火或向量。

原生提示词可使用 `$C` 获取本书结构化上下文，或通过现有 EJS 的 `originalGuide` 读取。聊天元数据 `acu_original_guide_context_v2` 可声明边界：

```json
{"bookId":"book-id","currentNodeId":"node-now","allowedNodeIds":["local","node-past","node-now"],"rowNodeIds":{"7":"node-past"},"rules":"只把已允许节点的候选纪要视为发生事实"}
```

自动追加和手工事实标为 `local`；原著导入必须显式给出 `nodeId`。未配置时，卡只采用真实消息变量 `canon_cursor.start` 的节点和本局事实，不按章节数字猜测。冻结请求发送前过滤表行，返回展开时再校验编码。SQL、EJS、总结索引读取同一份 detached SQLite 候选；不读取实时世界书、人物资料或不能按节点验证的原始历史正文。

## 存档和轮回

v3 包保存纪要表结构、来源、稳定行 ID、节点映射、版本、摘要及纯文本历史。轮回最多带一个不可变原始来源，当前和冻结来源共用同一 LLM 管线；结果以来源/快照/行 ID 区分，保留人物前缀和 MVU 身份表，派生档不能再次轮回。

旧 `xz_memory_v1` 仅作读取迁移。聊天来源先核对楼层与 swipe；导入资料缺节点时要求映射。旧轮回锚点经原有结构校验后转为独立冻结来源。交火字段仅作旧包解析兼容，不创建索引或调用 embedding/reranker。

恢复先走数据库锁、V2 历史提交与服务器回读确认，再物化世界书等资源。跨资源操作不构成原子事务；数据库已确认而其他资源失败时保留完整包并提示重试，避免声称整体成功或倒退已确认数据库。

## 验证边界

定向测试覆盖原生委派、写入范围、SQLite 往返、节点过滤、冻结请求、配置更新、幂等恢复和外层生成阻断。构建与卡语法检查属于本地证据；真实 SillyTavern 浏览器保存/重载、事件时序、模型语义和轮回入场仍须单独验收。本任务不部署生产。
