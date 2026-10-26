# v2 代码实施指令

本文是 original-guide-native-llm-migration-v2.md 的代码级执行清单。以当前代码核实后的实际签名为准；下面的新类型/新函数均为待新增，不是假定已有 API。

## 1. 先改契约，不保留旧 AI 入口

修改 src/memory/backend-contract.ts：
- FillRequest 移除 messages。改为 requestId、来源楼层范围/稳定消息身份、目标 sheetKey、操作类型（自动追加/明确补齐）、预期 revision、signal。
- RecallRequest 移除 messages。改为 requestId、generationIdentity、userInput、原著结构化上下文、source（current 或 frozen snapshot）、signal。
- MemoryConfig 不再有私有 fillPreset/recallPreset/anchorRecallPreset/crossfirePreset；读取数据库有效配置快照。提示词预设与 API 预设分开处理。
- 能力声明不再要求 crossfire；不要把未完成能力全部静态声明为 true。
- 源身份必须保留账号、聊天、书籍、表和冻结快照身份；旧编码仅作显示，不替代稳定行 ID。

修改 acu-memory-backend.ts：fill/recall 只调用下述原生 service adapter。移除 memoryModelRequest、parseMemoryFill、parseMemoryRecall、memoryCrossfire 导入。检查引用后删除不再使用的 memory-request.ts、memory-crossfire.ts 及独立 AI 输出协议；保留真正必要的旧数据迁移解析器并明确标注用途。CRUD/快照代码也要审查，不能用整表 replaceRecords 绕过原生锁、历史或提交规则。

## 2. 原生填表 adapter

新增 src/service/table/original-guide-fill-adapter.ts。

已存在调用链：
presentation/triggers/update-process.ts 的 processUpdatesBatch 包装
→ service/table/update-orchestrator.ts::processUpdatesBatch_ACU(indices, mode, options, callback)
→ callback 调 executeCardUpdateCore_ACU
→ prepareAIInput_ACU / callCustomOpenAI_ACU / 原生解析、重试、提交。

实现要求：
1. 参考 update-process.ts 约 250 行的批处理包装，复用相同参数透传；service adapter 不导入 presentation。callback 直接调用 executeCardUpdateCore_ACU，按现有包装透传批次控制器、progressContext 与进度事件。
2. 先追溯该包装上游的忙状态/队列与来源快照准入；抽出可共享的服务准入或复用已有调度器。不要在全局 busy 为 false 时直接开第二条独立队列。
3. 使用宿主 gateway 获得真实消息并验证 active swipe/目标楼层。来源范围转为原生批次索引，目标仅为 scope.sheetKey，不采用默认“全部表”。
4. 新增请求级写策略类型（放 table 层）：只约束本次自动纪要任务允许的目标表、业务列和追加操作。接入原生解析之后、提交之前；SQL 和 JSON/工具模式都统一检查解析后的操作或前后状态差异。不要仅用正则检查模型 SQL 字符串。
5. 范围/表/来源错误在模型调用前拒绝；模型输出违规走现有解析失败/纠错重试机制，不新增外层 for 重试。先搜索 runTableUpdateCommit_ACU 的调用点确定同一写策略覆盖所有提交分支。
6. 保留 prompt-api-call.ts 中 charCardPrompt/strictJson* 选择及工具模式适配。不传完整提示词覆盖参数，不把旧 card SQL 示例拼进严格 JSON 模式。
7. 自动提取只由数据库调度；卡手工补齐按钮调用 adapter。重复触发返回同一任务回执，避免卡和数据库各填一次。

## 3. 原生 LLM 召回 adapter

新增 src/service/plot/original-guide-recall-adapter.ts。

参考代码不是自建请求器，而是：
- runtime/plot-runtime/plot-task-engine.ts::runPlotTasksRuntime_ACU。
- runtime/plot-runtime/plot-request-context.ts::PlotRequestContext_ACU。
- zero-layer/plot-preparation.ts::prepareZeroLayerPlot_ACU 的隔离上下文、冻结渠道和 detached SQLite 生命周期。
- plot/plot-logic.ts 中当前聊天预设解析/绑定。

实施步骤：
1. 检查当前聊天有效填表模式为 llm；不要直接改全局开关，也不要临时启用 crossfire。初始化通过现有聊天设置服务保存模式。
2. 冻结当前有效 plotSettings、promptGroup/plotTasks、API 渠道与配置 revision。解析规则复用现有聊天绑定，不默认拿全局 presetName 冒充聊天配置。
3. 从 prepareZeroLayerPlot_ACU 提取可复用的请求上下文工厂，或在新的 adapter 调用同一底层 helper；不能改变零层行为。普通本局与轮回使用同一工厂，只有候选快照不同。
4. 使用 createDetachedSqlTableService_ACU 为冻结表格建立请求级 SQL reader；try/finally dispose。ejsContext、history、tableData、sqlReadContext 一致，绝不替换全局 currentJsonTableData。
5. requestContext.callApi 使用原生 API 预设解析/传输。重试仍由 executeSinglePlotTask_ACU 所在任务引擎拥有，不在 adapter 重写。参考零层的 custom-only 限制，但不要无依据扩散到所有普通召回；主 API 能否隔离需根据真实接口验证，不能满足时明确报配置不兼容。
6. 调 runPlotTasksRuntime_ACU(plotSettings, userInput, { requestContext, inputForHash })。检查 failedResults、apiRetriesExhausted、abortedByStageFailure 等现有失败结果；部分成功不得作为完整召回注入。
7. 引擎已返回 successfulResults、aggregatedTags、finalMessage/saveContent。沿 plot-tag-utils.ts 与原生纪要展开调用方查出实际召回输出消费位置，将该消费逻辑提取为共享函数；不要新增 parseMemoryRecall 或要求模型改成 {ids:[]}。
8. 新增结果导出方式时保持原生默认调用行为不变。桥接只获取经原生解释、按来源校验的召回部分。finalMessage 可能含剧情建议，不能整段当历史事实注入；若预设无法区分召回与建议，报告明确的预设配置错误并指向数据库配置界面。
9. 添加本书上下文参数/模板变量适配点，使用原生变量渲染器；变量不存在时展示说明，不默默覆盖用户 promptGroup。特殊补充规则不能改变原生返回格式。

## 4. 轮回隔离及候选过滤

- 在 memory snapshot 中保存来源 identity、schema、表数据/恢复所需历史、revision/hash、冻结时间。不要仅保存 exportTableAsJson 的当前投影就称为完整恢复包。
- current 与 frozen 两个 source 均调用第 3 节 adapter；携带旧档不意味着开启交火。最多一个旧档、禁止派生档再次轮回等约束由卡编排和 backend 准入共同验证。
- 输出身份使用 sourceScope + snapshotId + stableRowId；同名 AM0001 可以同时存在，不允许互相覆盖。
- 逐项审查 plot-task-engine.ts 中 requestContext 缺省回退、世界书读取、SQL/EJS 模板、总结索引、agent/worldbook 分支。世界书中数据库自动生成的源档最新纪要不能绕过快照进入提示词。
- 原著未来剧情与本局事实分开。发送前过滤不允许的候选，返回展开时再次验证 ID；缺少节点映射时报错，不凭时间/章节大小猜测。
- 不可靠的分支要实现明确 request-scoped 数据入口；不得以暂时换全局变量再还原解决。

## 5. 角色卡与生成 hook

- 角色卡输入源由 ORIGINAL_GUIDE_SOURCE 显式指定。先核对该文件的当前状态/来源，不直接修改生产 VPS；完整生成卡仅作本地交付，不提交个人卡正文或本机路径。
- 编写可重跑的卡转换脚本与转换说明，对唯一锚点和源摘要校验，输出到项目单独交付目录。迁移 installMemoryManager 的 fill/recall 调用与旧提示词 UI，保留原著推进、MVU、存档和轮回角色编排。
- presentation/bootstrap/api-groups/memory-api.ts 仅暴露新契约并版本化；api-registry.ts 按现有习惯注册。不保留旧卡绕过原生流程的隐式回退。
- 生成调度必须只有一个所有者：原生自动 hook 识别当前书籍已被桥接接管时委派给同一任务；其他聊天保持原行为。不要全局关闭 plotSettings.enabled，否则 llm 逻辑召回一起失效。
- 复用/扩展实际宿主 generation bridge 的阻断与取消接口；不要把事件异常当停止生成。任务身份绑定稳定 message/swipe、配置和后端 revision，跨聊天或任务过期立即取消。
- 存档恢复依赖数据库正式 restore 回执，再完成卡其他资源物化；跨资源失败明确可恢复，不能虚称跨宿主原子事务。

## 6. 执行顺序与最小验收

按契约 → 原生填表 → 原生召回 → 冻结来源 → 卡转换/唯一 hook → 存档恢复 → 打包交付执行。每步实际接上后继续下一步，不停在 UNSUPPORTED 骨架或 mock 结果。

定向检查：
1. 原生入口被调用，数据库提示词修改可观察到实际请求组装变化，卡不再传 messages。
2. llm 模式不调用向量/交火，重复 hook 一次任务一次注入。
3. 原生填表禁止越表写入，失败走原生重试，成功不再额外 commit 一次。
4. 冻结候选不随来源后续修改变化，同编号不同来源不碰撞，SQL/EJS/世界书均不泄漏最新旧档。
5. 针对修改运行定向测试、类型检查、必要构建与 git diff --check；不反复运行全量套件。构建产物与 JSON 脚本同步核验。

提交到本任务功能分支 feature/original-guide-unique-memory-backend（用户任务分支优先于通用 main 发布说明），推送 paff67/shujuku；不覆盖 naiv1.2.9，不部署生产，除非用户另行授权明确该发布范围。报告已实现、测试、实际宿主/模型尚未验收部分，不能把打包推送称为生产迁移成功。
