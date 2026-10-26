import { executeCardUpdateCore_ACU, processUpdatesBatch_ACU } from './update-orchestrator';
import { currentJsonTableData_ACU, isAutoUpdatingCard_ACU, isProcessing_Plot_ACU, _set_isAutoUpdatingCard_ACU, _set_wasStoppedByUser_ACU } from '../runtime/state-manager';
import { getChatArray_ACU } from '../../data/gateways/chat-gateway';
import { captureAiMessageSnapshot_ACU } from '../../data/gateways/chat-message-snapshot';
import { columns, digest, fail, stateFromData } from '../../memory/memory-mapper';
import { memoryScopeKey, type MemoryScope } from '../../memory/memory-scope';
import type { FillRequest, OriginalGuideSheet } from '../../memory/backend-contract';
import { sourceFloorIdentity_ACU } from './original-guide-fill-strategy';
const active = new Map<string, { fingerprint: string; promise: Promise<void> }>();
/** Card manual completion enters the native scheduler; automatic extraction never starts here. */
export async function fillOriginalGuideNative_ACU(scope: MemoryScope, request: FillRequest, assertCurrent: () => void): Promise<void> {
  if (request.operation !== 'explicit_refill' || request.targetSheetKey !== scope.sheetKey || !request.requestId?.trim()) fail('MEMORY_REQUEST_INVALID', '补齐操作或目标表无效');
  const fingerprint = digest({ ...request, signal: undefined }), taskKey = memoryScopeKey(scope) + ':' + request.requestId;
  if (!Array.isArray(request.sourceFloors) || request.sourceFloors.some(ref => !Number.isSafeInteger(ref.index) || ref.index < 0 || !Number.isSafeInteger(ref.swipeId) || ref.swipeId < 0)) fail('MEMORY_REQUEST_INVALID','来源楼层身份无效');
  const running = active.get(taskKey);
  if (running) { if (running.fingerprint !== fingerprint) fail('MEMORY_REQUEST_REUSED', 'requestId 已用于其他填写请求'); return running.promise; }
  const previous = (currentJsonTableData_ACU?.[scope.sheetKey] as OriginalGuideSheet)?.originalGuide?.requests[request.requestId];
  if (previous) { if (previous.fingerprint !== fingerprint) fail('MEMORY_REQUEST_REUSED', 'requestId 已用于其他填写请求'); return; }
  if (isAutoUpdatingCard_ACU || isProcessing_Plot_ACU) fail('MEMORY_BUSY', '数据库正在运行任务，请等待现有任务完成');
  const chat = getChatArray_ACU();
  if (!request.sourceFloors?.length) fail('MEMORY_REQUEST_INVALID', '未选择来源楼层');
  const snapshots = request.sourceFloors.map(ref => {
    const snapshot = captureAiMessageSnapshot_ACU(chat, ref.index);
    if (snapshot.message.is_system || digest(sourceFloorIdentity_ACU(snapshot.message, ref.index)) !== digest(ref)) fail('MEMORY_SOURCE_CHANGED', '来源楼层或 active swipe 已变化');
    return snapshot;
  });
  const indices = [...new Set(snapshots.map(s => s.index))].sort((a,b) => a-b);
  if (indices.length !== snapshots.length) fail('MEMORY_REQUEST_INVALID', '来源楼层重复');
  if (stateFromData(currentJsonTableData_ACU!, scope).revision !== request.expectedRevision) fail('MEMORY_COMMIT_CONFLICT', '填写前纪要版本变化');
  const controller = new AbortController(), abort = () => controller.abort();
  request.signal?.addEventListener('abort', abort, { once: true });
  if (request.signal?.aborted) abort();
  const check = () => { controller.signal.throwIfAborted(); assertCurrent(); for (const snap of snapshots) {
    if (chat[snap.index] !== snap.message || Number(snap.message.swipe_id || 0) !== snap.swipeId || String(snap.message.mes || '') !== snap.body) fail('MEMORY_SOURCE_CHANGED', '填写来源已变化');
  } };
  _set_isAutoUpdatingCard_ACU(true); _set_wasStoppedByUser_ACU(false);
  const promise = (async () => {
    try {
      check();
      const strategy = { scope, requestId: request.requestId, fingerprint, operation: 'append' as const,
        allowedColumns: Object.values(columns(currentJsonTableData_ACU![scope.sheetKey] as any)).filter(i => i > 0) };
      // One native batch = one native commit and one idempotent receipt. No outer model retry.
      const result = await processUpdatesBatch_ACU(indices, 'manual', { targetSheetKeys: [scope.sheetKey], batchSize: indices.length,
        abortController: controller, planManaged: true, requestOptions: { originalGuideStrategy: strategy } },
        (messages, target, mode, silent, sheets, options, progress, batchController) => {
          check();
          return executeCardUpdateCore_ACU(messages, target, false, mode, silent, sheets, options, batchController, progress);
        });
      check();
      if (!result.success) fail(result.aborted ? 'MEMORY_ABORTED' : 'MEMORY_FILL_FAILED', result.error || '原生填写未完成');
    } finally { _set_isAutoUpdatingCard_ACU(false); _set_wasStoppedByUser_ACU(false); request.signal?.removeEventListener('abort', abort); }
  })();
  active.set(taskKey, { fingerprint, promise });
  try { await promise; } finally { active.delete(taskKey); }
}
