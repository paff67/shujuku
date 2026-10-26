import { settings_ACU } from '../runtime/state-manager';
import { getCurrentChatPlotScopeState_ACU } from '../template/chat-scope';
import { applyPlotPresetToSettings_ACU, findPlotPresetByName_ACU, getCurrentRuntimePlotPresetName_ACU, normalizePlotTasks_ACU } from './plot-logic';
import { callAIWithResolvedPreset_ACU, getApiConfigByPreset_ACU, requireResolvedApiPreset_ACU } from '../ai/api-call';
import { resolveCurrentChatFillMode_ACU } from '../fill-mode/fill-mode-chat-record';
import { createDetachedSqlTableService_ACU } from '../table/table-storage-strategy';
import { runPlotTasksRuntime_ACU } from '../runtime/plot-runtime/plot-task-engine';
import type { PlotRequestContext_ACU } from '../runtime/plot-runtime/plot-request-context';
import type { TableDataObject_ACU } from '../../shared/models/table-data';
import type { MemorySnapshot, RecallRequest, RecallReceipt } from '../../memory/backend-contract';
import { clone, digest, fail, stateFromData } from '../../memory/memory-mapper';
import { memoryScopeKey } from '../../memory/memory-scope';
import { exportNativePlotRecall_ACU, filterOriginalGuideCandidates_ACU } from './original-guide-recall-result';
export function captureOriginalGuidePlotConfig_ACU() {
  const presetName = getCurrentRuntimePlotPresetName_ACU(), scoped = getCurrentChatPlotScopeState_ACU();
  const plotSettings = clone(settings_ACU.plotSettings);
  if (scoped?.snapshot) Object.assign(plotSettings, clone(scoped.snapshot));
  else if (presetName) {
    const preset = findPlotPresetByName_ACU(presetName);
    if (!preset) fail('MEMORY_PRESET_INCOMPATIBLE', '聊天绑定的剧情预设不存在');
    applyPlotPresetToSettings_ACU(plotSettings, clone(preset));
  }
  const overrides = clone(settings_ACU.plotTaskApiPresetOverridesById || {}), defaultPreset = String(settings_ACU.plotApiPreset || '');
  const presets = new Map<string, ReturnType<typeof getApiConfigByPreset_ACU>>();
  for (const name of new Set<string>(['', ...(settings_ACU.apiPresets || []).map((p: {name:string}) => p.name)])) presets.set(name, clone(getApiConfigByPreset_ACU(name)));
  return { plotSettings, presetName, overrides, defaultPreset, presets, streaming: settings_ACU.streamingEnabled === true,
    revision: digest([plotSettings, presetName, overrides, defaultPreset, [...presets], settings_ACU.streamingEnabled === true]) };
}
/** Native plot task execution with request-scoped table/SQL/EJS/history sources. */
export async function recallOriginalGuideNative_ACU(snapshot: MemorySnapshot, request: RecallRequest, assertCurrent: () => void): Promise<RecallReceipt> {
  if (resolveCurrentChatFillMode_ACU().mode !== 'llm') fail('MEMORY_MODE_INCOMPATIBLE', '请在数据库聊天设置中选择 LLM 逻辑召回模式');
  const frozen = clone(snapshot), config = captureOriginalGuidePlotConfig_ACU();
  if (!config.plotSettings.enabled) fail('MEMORY_PRESET_INCOMPATIBLE', '请在数据库配置界面启用剧情任务，LLM 召回依赖该模块');
  if (!normalizePlotTasks_ACU(config.plotSettings).some((task: any) => task.enabled !== false && [task.extractTags, task.extractInjectTags].join(',').split(',').some(tag => tag.trim().toLowerCase() === 'recall'))) fail('MEMORY_PRESET_INCOMPATIBLE', '数据库预设需要可独立导出的 recall 标签；请打开数据库配置界面');
  if (request.original.bookId !== frozen.scope.bookId) fail('MEMORY_SCOPE_MISMATCH', '原著上下文不属于候选书籍');
  const candidates = filterOriginalGuideCandidates_ACU(stateFromData(frozen.tableData, frozen.scope).records, request.original);
  const sheet = clone(frozen.tableData[frozen.scope.sheetKey]) as any;
  const allowedRows = new Set(candidates.map(r => r.stableRowId));
  sheet.content = [sheet.content[0], ...sheet.content.slice(1).filter((row:any[]) => allowedRows.has(String(row[0])))];
  delete sheet.seedRows;
  const data = { mate: clone(frozen.tableData.mate), [frozen.scope.sheetKey]: sheet } as TableDataObject_ACU;
  // Raw source dialogue is not node-addressable. Only filtered facts enter recall;
  // current player input is supplied separately, so a cutoff cannot leak through $4/history/EJS.
  const history: Record<string, any>[] = [], controller = new AbortController(), abort = () => controller.abort();
  request.signal?.addEventListener('abort', abort, { once: true }); if (request.signal?.aborted) abort();
  const check = () => { controller.signal.throwIfAborted(); assertCurrent(); if (captureOriginalGuidePlotConfig_ACU().revision !== config.revision) fail('MEMORY_CONFIG_CHANGED', '召回期间数据库有效配置变化'); };
  const provider = createDetachedSqlTableService_ACU();
  try {
    check(); const loaded = await provider.loadFromData(data); check();
    if (loaded.error || !provider.isReady()) fail('MEMORY_SNAPSHOT_INVALID', '冻结纪要的独立 SQLite 读取器未就绪');
    const tableData = provider.getCurrentDataStrict_ACU();
    if ((tableData[frozen.scope.sheetKey] as any).content.slice(1).some((row: any[]) => !allowedRows.has(String(row[0])))) fail('MEMORY_SNAPSHOT_INVALID', 'SQLite 候选包含未授权的种子行');
    const originalGuideText = JSON.stringify(request.original);
    const context: PlotRequestContext_ACU = { controlledSource: true, history, tableData, presetName: config.presetName,
      signal: controller.signal, sqlReadContext: { provider, mapper: provider.createReadNameMapper_ACU(), tableData },
      ejsContext: { chat: clone(history), allTablesJson: clone(tableData), userMessage: request.userInput,
        originalGuide: clone(request.original), originalGuideText }, finalPromptEntries: [], assertCurrent: check,
      resolveTaskApiPreset: task => String(config.overrides[String(task.id || '')] || task.taskApiPreset || config.defaultPreset).trim(),
      async callApi(messages, name) {
        check(); const resolved = config.presets.get(name);
        if (!resolved) fail('MEMORY_PRESET_INCOMPATIBLE', 'API 预设不属于冻结配置');
        requireResolvedApiPreset_ACU(name, resolved);
        // generateRaw consults live host presets/character/worldbooks; it cannot honor frozen source isolation.
        if (resolved.apiMode !== 'custom' || !resolved.apiConfig.url || !resolved.apiConfig.model) fail('MEMORY_PRESET_INCOMPATIBLE', '冻结召回需要数据库独立 API；宿主 generateRaw 无法隔离来源');
        const response = await callAIWithResolvedPreset_ACU(messages, { ...resolved, apiConfig: { ...resolved.apiConfig, useMainApi: false } }, controller.signal, undefined, { streaming: config.streaming });
        check(); return response;
      },
    };
    const result = await runPlotTasksRuntime_ACU(config.plotSettings, request.userInput, { requestContext: context, inputForHash: request.userInput }); check();
    if (result.failedResults.length || ('apiRetriesExhausted' in result && result.apiRetriesExhausted) || ('abortedByStageFailure' in result && result.abortedByStageFailure)) fail('MEMORY_RECALL_FAILED', '原生剧情召回任务未全部完成，正文已阻断');
    const selected = exportNativePlotRecall_ACU(result.successfulResults, candidates);
    const validated = filterOriginalGuideCandidates_ACU(selected, request.original);
    const sourceScope = memoryScopeKey(frozen.scope);
    const records = validated.map(row => ({ ...row, sourceScope, snapshotId: frozen.snapshotId }));
    return { requestId: request.requestId, generationIdentity: request.generationIdentity, revision: frozen.revision,
      configRevision: config.revision, sourceScope: frozen.scope, snapshotId: frozen.snapshotId, records,
      content: records.map(row => '[' + sourceScope + '/' + frozen.snapshotId + '/' + row.stableRowId + '] ' + row.code + ' ' + row.time + '\n' + row.text + (row.dialogue ? '\n' + row.dialogue : '')).join('\n\n') };
  } finally { provider.dispose(); request.signal?.removeEventListener('abort', abort); }
}
