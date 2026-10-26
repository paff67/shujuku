import { currentJsonTableData_ACU } from '../service/runtime/state-manager';
import { assertMemoryHostScope_ACU, captureMemoryHost_ACU, readMemoryAccount_ACU } from '../data/gateways/memory-host-gateway';
import { readChatFromHostStrict_ACU } from '../data/gateways/chat-gateway';
import { runTableUpdateCommit_ACU } from '../service/table/table-update-commit';
import { ensureStorageProviderReady_ACU, reloadStorageProvider } from '../service/table/table-storage-strategy';
import { loadTableStateFromFramesV2Detailed_ACU } from '../service/table/storage-frame-v2-replay';
import { getTableLockIdentitiesForSheet_ACU } from '../service/runtime/helpers-table-lock';
import { createStableRowIdReservation_ACU, allocateStableRowId_ACU } from '../shared/stable-row-id-allocator';
import { getUiSurface_ACU } from '../shared/ui-surface-registry';
import { fillOriginalGuideNative_ACU } from '../service/table/original-guide-fill-adapter';
import { recallOriginalGuideNative_ACU, captureOriginalGuidePlotConfig_ACU } from '../service/plot/original-guide-recall-adapter';
import { sourceFloorIdentity_ACU } from '../service/table/original-guide-fill-strategy';
import { setCurrentChatFillMode_ACU } from '../service/fill-mode/fill-mode-chat-switch';
import type { TableDataObject_ACU } from '../shared/models/table-data';
import type { TableMutationOperationV2_ACU } from '../service/table/storage-frame-v2-types';
import { assertMemoryScope, memoryScopeKey, type MemoryScope } from './memory-scope';
import type { CommitReceipt, FillRequest, MemoryChange, MemoryRecordPatch, MemorySnapshot, OriginalGuideSheet, RecallRequest, RestoreOptions } from './backend-contract';
import { clone, columns, digest, fail, selectSheet, stateFromData } from './memory-mapper';
import { migrateLegacyMemory_ACU } from './legacy-memory-migration';
import { originalGuideNote_ACU } from './original-guide-rules';
const subscribers = new Set<{ scope: MemoryScope; listener: (event: MemoryChange) => void }>();
export function invalidateMemoryBackend_ACU(): void { for (const item of subscribers) item.listener({ scopeKey: memoryScopeKey(item.scope), revision: '', kind: 'invalidated', recordIds: [] }); }
function tables(): TableDataObject_ACU { if (!currentJsonTableData_ACU?.mate) fail('MEMORY_NOT_READY', '数据库尚未初始化'); return clone(currentJsonTableData_ACU); }
function targetIndex(chat: any[]): number { let index = -1; for (let i=chat.length-1;i>=0;i--) { if (!chat[i]?.is_user && !chat[i]?.is_system) { index=i; break; } } if (index < 0) fail('MEMORY_NOT_READY', '需要真实角色楼层保存数据库'); return index; }
async function serverTables(scope: MemoryScope): Promise<TableDataObject_ACU> {
  const messages = await readChatFromHostStrict_ACU();
  const replay = await loadTableStateFromFramesV2Detailed_ACU(messages, scope.isolationKey, { updateRuntimeState: false, compatibilityMode: 'disabled', allowTemporaryTemplateBaseline: false });
  if (!replay || replay.baseKind !== 'full_checkpoint' || replay.requiresCheckpointConvergence || replay.compatibilityRepairs?.length) fail('MEMORY_READBACK_FAILED', '服务器数据库未通过严格 V2 回放');
  return replay.data;
}
export class AcuMemoryBackend {
  capabilities() { return { version: '2', fill: 'native', recall: 'native-llm', snapshot: 2, generationOwner: 'database' } as const; }
  async resolveScope(options: { bookId: string; sheetKey?: string; allowRebind?: boolean }): Promise<MemoryScope> {
    const host = captureMemoryHost_ACU(), account = await readMemoryAccount_ACU(); host.assertCurrent();
    await ensureStorageProviderReady_ACU(); host.assertCurrent();
    const scope = { account, isolationKey: host.identity.isolationKey, avatar: host.identity.avatar, chatId: host.identity.chatId,
      bookId: options.bookId, sheetKey: selectSheet(tables(), options.sheetKey), schemaVersion: 1 };
    assertMemoryScope(scope);
    if (host.identity.bookId !== scope.bookId) fail('MEMORY_SCOPE_MISMATCH', '角色卡书籍 ID 不一致');
    if (!options.allowRebind) stateFromData(tables(), scope);
    return scope;
  }
  async read(scope: MemoryScope) { assertMemoryScope(scope); const host = await assertMemoryHostScope_ACU(scope); await ensureStorageProviderReady_ACU(); host.assertCurrent(); return stateFromData(tables(), scope); }
  async ready(scope: MemoryScope) { try { await this.read(scope); return { ok: true, bound: !!(tables()[scope.sheetKey] as OriginalGuideSheet).originalGuide }; } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; } }
  sourceFloors(start: number, end: number) { const host = captureMemoryHost_ACU(); if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > host.chat.length || start >= end) fail('MEMORY_REQUEST_INVALID', '来源范围无效'); return host.chat.flatMap((m,i) => i >= start && i < end && !m.is_user && !m.is_system ? [sourceFloorIdentity_ACU(m,i)] : []); }
  async settings() { const config = captureOriginalGuidePlotConfig_ACU(); return { promptPreset: config.presetName, revision: config.revision, recallTag: 'recall', originalContextVariable: 'originalGuide', originalContextPlaceholder: '$C' }; }
  async initialize(scope: MemoryScope, id: string, rowNodeIds: Record<string, string> = {}) {
    const host = await assertMemoryHostScope_ACU(scope);
    const mode = await setCurrentChatFillMode_ACU('llm');
    if (!mode.ok) fail('MEMORY_MODE_INCOMPATIBLE', '无法保存 LLM 模式：' + ('reason' in mode ? mode.reason : 'unknown'));
    host.assertCurrent(true);
    return this.mutate(scope, id, { kind: 'bind', rowNodeIds }, undefined, (data, sheet) => {
      sheet.sourceData.note = originalGuideNote_ACU(sheet.sourceData.note);
      sheet.originalGuide!.rowNodeIds = { ...sheet.originalGuide!.rowNodeIds, ...clone(rowNodeIds) };
      const records = stateFromData(data, scope).records;
      if (records.some(row => !sheet.originalGuide!.rowNodeIds?.[row.stableRowId])) fail('MEMORY_NODE_MAPPING_REQUIRED', '既有纪要需要显式节点映射后绑定');
      return [];
    });
  }
  private async mutate(scope: MemoryScope, id: string, operation: unknown, expected: string | undefined,
    apply: (data: TableDataObject_ACU, sheet: OriginalGuideSheet, operations: TableMutationOperationV2_ACU[]) => string[], rebind = false): Promise<CommitReceipt> {
    if (!id?.trim()) fail('MEMORY_REQUEST_INVALID', '需要 requestId');
    const host = await assertMemoryHostScope_ACU(scope); await ensureStorageProviderReady_ACU(); host.assertCurrent(true);
    const fingerprint = digest(operation);
    const result = await runTableUpdateCommit_ACU<CommitReceipt>({ source: 'manual_crud', reason: 'original-guide:' + (operation as any).kind,
      chatKey: host.identity.chatKey, isolationKey: scope.isolationKey, writeSet: [{ kind: 'sheet', sheetKey: scope.sheetKey }],
      targetMessageIndex: targetIndex(host.chat), targetSheetKeys: [scope.sheetKey], trackingSheetKeys: [], strictSave: true }, ({ workingData, transactionContext }) => {
      host.assertCurrent(true); transactionContext.assertFresh?.('original-guide');
      const data = clone(workingData!), sheet = data[scope.sheetKey] as OriginalGuideSheet;
      columns(sheet);
      const prior = sheet.originalGuide?.requests[id];
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail('MEMORY_REQUEST_REUSED', 'requestId 被用于其他操作');
        return { success: true, tableData: data, value: { requestId: id, scopeKey: memoryScopeKey(scope), revision: stateFromData(data,scope).revision, status: 'deduplicated' as const, recordIds: prior.recordIds }, persist: { operations: [] } };
      }
      const revision = rebind ? digest(sheet) : stateFromData(data, scope).revision;
      if (expected !== undefined && revision !== expected) fail('MEMORY_COMMIT_CONFLICT', '数据库版本变化，请重新核对');
      if (getTableLockIdentitiesForSheet_ACU(scope.sheetKey, sheet.content).hasAny) fail('MEMORY_TABLE_LOCKED', '纪要表存在锁定单元格，请先在数据库面板解锁');
      sheet.originalGuide ||= { version: 2, scope: clone(scope), lineage: 'original', requests: {} };
      const operations: TableMutationOperationV2_ACU[] = [], recordIds = apply(data, sheet, operations);
      const next = data[scope.sheetKey] as OriginalGuideSheet;
      next.originalGuide!.requests[id] = { fingerprint, recordIds };
      // Sheet metadata and row operations share the native lock/history/save transaction.
      operations.push({ kind: 'sheet_replace', sheetKey: scope.sheetKey, sheet: next, reason: rebind ? 'import' : 'manual_crud' });
      const receipt: CommitReceipt = { requestId: id, scopeKey: memoryScopeKey(scope), revision: stateFromData(data,scope).revision, status: 'committed', recordIds };
      return { success: true, tableData: data, value: receipt, persist: { operations, strictSave: true } };
    });
    if (!result.success || !result.value) fail('MEMORY_COMMIT_FAILED', result.error || '数据库提交失败');
    const runtime = await reloadStorageProvider(); host.assertCurrent(true);
    if (!runtime.ok) fail('MEMORY_COMMIT_UNCONFIRMED', '已写入聊天，但数据库运行时重载失败；请保留相同 requestId 重试');
    const verified = await serverTables(scope); host.assertCurrent(true);
    if (stateFromData(verified, scope).revision !== result.value.revision) fail('MEMORY_COMMIT_UNCONFIRMED', '服务器回读版本未确认；请保留相同 requestId 重试');
    for (const sub of subscribers) { if (memoryScopeKey(sub.scope) === memoryScopeKey(scope)) try { sub.listener({ scopeKey: memoryScopeKey(scope), revision: result.value.revision, kind: 'committed', recordIds: result.value.recordIds }); } catch { /* committed state is authoritative */ } }
    return result.value;
  }
  async insert(scope: MemoryScope, record: MemoryRecordPatch, id: string, nodeId = 'local') {
    return this.mutate(scope, id, { kind: 'insert', record, nodeId }, undefined, (data, sheet, operations) => {
      const row = Array(sheet.content[0].length).fill(''); row[0] = allocateStableRowId_ACU(new Set([...(sheet.originalGuide?.reservedRowIds || []), ...createStableRowIdReservation_ACU(sheet.content.slice(1))]));
      if (!nodeId?.trim()) fail('MEMORY_NODE_MAPPING_REQUIRED','导入纪要需要显式节点');
      this.patchRow(sheet, row, record); sheet.content.push(row);
      sheet.originalGuide!.reservedRowIds = [...new Set([...(sheet.originalGuide!.reservedRowIds || []), String(row[0])])];
      (sheet.originalGuide!.rowNodeIds ||= {})[String(row[0])] = nodeId;
      operations.push({ kind: 'row_upsert', sheetKey: scope.sheetKey, rowId: row[0], cells: row });
      return stateFromData(data, scope).records.filter(r => r.stableRowId === String(row[0])).map(r => r.id);
    });
  }
  private patchRow(sheet: OriginalGuideSheet, row: (string | null)[], patch: MemoryRecordPatch) {
    const map = columns(sheet);
    for (const [field, value] of Object.entries(patch)) {
      if (!(field in map) || typeof value !== 'string') fail('MEMORY_RECORD_INVALID', '不支持的纪要字段：' + field);
      if (map[field] < 0) { if (value) fail('MEMORY_SCHEMA_INVALID', '数据库模板没有列：' + field); continue; }
      row[map[field]] = value;
    }
  }
  async update(scope: MemoryScope, recordId: string, patch: MemoryRecordPatch, id: string, expected?: string) {
    return this.mutate(scope,id,{ kind: 'update', recordId, patch },expected,(data,sheet,operations) => {
      const record = stateFromData(data,scope).records.find(r => r.id === recordId); if (!record) fail('MEMORY_RECORD_MISSING','纪要不存在');
      const row = sheet.content.find(r => String(r[0]) === record.stableRowId)!; this.patchRow(sheet,row,patch);
      operations.push({ kind: 'row_upsert', sheetKey: scope.sheetKey, rowId: record.stableRowId, cells: row }); return [recordId];
    });
  }
  async remove(scope: MemoryScope, recordId: string, id: string, expected?: string) {
    return this.mutate(scope,id,{ kind: 'remove', recordId },expected,(data,sheet,operations) => {
      const record = stateFromData(data,scope).records.find(r => r.id === recordId); if (!record) fail('MEMORY_RECORD_MISSING','纪要不存在');
      sheet.content = sheet.content.filter((row,index) => !index || String(row[0]) !== record.stableRowId);
      operations.push({ kind: 'row_delete', sheetKey: scope.sheetKey, rowId: record.stableRowId }); return [recordId];
    });
  }
  async fill(scope: MemoryScope, request: FillRequest): Promise<CommitReceipt> {
    const host = await assertMemoryHostScope_ACU(scope);
    const previous = (tables()[scope.sheetKey] as OriginalGuideSheet).originalGuide?.requests[request.requestId];
    await fillOriginalGuideNative_ACU(scope,request,() => host.assertCurrent(true));
    const confirmed = await serverTables(scope); host.assertCurrent(true);
    const receipt = (confirmed[scope.sheetKey] as OriginalGuideSheet).originalGuide?.requests[request.requestId];
    if (!receipt) fail('MEMORY_COMMIT_UNCONFIRMED','原生填写回执未通过服务器回读');
    return { requestId: request.requestId, scopeKey: memoryScopeKey(scope), revision: stateFromData(confirmed,scope).revision,
      status: previous ? 'deduplicated' : 'committed', recordIds: receipt.recordIds };
  }
  private snapshotData(scope: MemoryScope, data: TableDataObject_ACU, history: any[]): MemorySnapshot {
    const state = stateFromData(data,scope), tableData = { mate: clone(data.mate), [scope.sheetKey]: clone(data[scope.sheetKey]) } as TableDataObject_ACU;
    // Prompt history is plain text only. Live table frames and other-save anchors are not copied into request history.
    const safeHistory = history.map(m => ({ mes: String(m.mes || ''), is_user: !!m.is_user, is_system: !!m.is_system, swipe_id: Number(m.swipe_id || 0) }));
    const payload = { format: 'acu-original-guide-snapshot' as const, schemaVersion: 2 as const, snapshotId: digest([scope,state.revision,safeHistory]), scope: clone(scope),
      frozenAt: Date.now(), revision: state.revision, tableData, history: safeHistory, lineage: (data[scope.sheetKey] as OriginalGuideSheet).originalGuide?.lineage || 'original' as const };
    return { ...payload, hash: digest(payload) };
  }
  async snapshot(scope: MemoryScope) { const host = await assertMemoryHostScope_ACU(scope); await this.read(scope); host.assertCurrent(true); return this.snapshotData(scope,tables(),host.chat); }
  async snapshotFromMessages(scope: MemoryScope, messages: any[], options: { bookId?: string; chatId?: string } = {}) {
    await assertMemoryHostScope_ACU(scope);
    if (!Array.isArray(messages) || messages.length < 2) fail('MEMORY_SNAPSHOT_INVALID', '快照缺少聊天数据');
    const metadata = messages[0]?.chat_metadata || {};
    const sourceScope = { ...scope, bookId: options.bookId || scope.bookId, chatId: options.chatId || scope.chatId };
    assertMemoryScope(sourceScope);
    const replay = await loadTableStateFromFramesV2Detailed_ACU(messages.slice(1),scope.isolationKey,{ updateRuntimeState: false, compatibilityMode: 'disabled', allowTemporaryTemplateBaseline: false });
    if (!replay || replay.baseKind !== 'full_checkpoint' || replay.requiresCheckpointConvergence) {
      if (metadata.xz_memory_v1) return this.snapshotData(sourceScope, migrateLegacyMemory_ACU(tables(), sourceScope, metadata, messages.slice(1)), messages.slice(1));
      if (messages.length === 2 && !messages[1]?.is_user && !messages[0]?.chat_metadata?.xz_memory_v1?.records?.length) {
        const empty = tables(), sheet = empty[scope.sheetKey] as OriginalGuideSheet;
        sheet.content = [sheet.content[0]]; delete sheet.seedRows;
        sheet.originalGuide = { version: 2, scope: clone(sourceScope), lineage: metadata.xz_reincarnation_v1?.kind === 'derived' ? 'derived' : 'original', requests: {} };
        return this.snapshotData(sourceScope,empty,messages.slice(1));
      }
      fail('MEMORY_SNAPSHOT_INVALID','旧存档缺少可严格回放的数据库；请先显式迁移');
    }
    const key = selectSheet(replay.data), stored = (replay.data[key] as OriginalGuideSheet).originalGuide?.scope;
    if (!stored || stored.account !== scope.account || stored.bookId !== sourceScope.bookId) fail('MEMORY_SCOPE_MISMATCH','存档数据库缺少本账号与来源书籍绑定');
    return this.snapshotData(stored,replay.data,messages.slice(1));
  }
  validateSnapshot(snapshot: MemorySnapshot): MemorySnapshot {
    if (snapshot?.format !== 'acu-original-guide-snapshot' || snapshot.schemaVersion !== 2) fail('MEMORY_SNAPSHOT_INVALID','不支持的数据库快照');
    const { hash, ...payload } = snapshot; assertMemoryScope(snapshot.scope);
    if (digest(payload) !== hash || stateFromData(snapshot.tableData,snapshot.scope).revision !== snapshot.revision || !Array.isArray(snapshot.history)) fail('MEMORY_SNAPSHOT_INVALID','快照摘要、结构或版本不一致');
    return clone(snapshot);
  }
  snapshotRecords(snapshot: MemorySnapshot) { const frozen = this.validateSnapshot(snapshot); return stateFromData(frozen.tableData,frozen.scope).records; }
  async stageRestore(scope: MemoryScope, snapshot: MemorySnapshot) { this.validateSnapshot(snapshot); await assertMemoryHostScope_ACU(scope); return { expectedRevision: digest(tables()[scope.sheetKey]), snapshotHash: snapshot.hash }; }
  async restore(scope: MemoryScope, snapshot: MemorySnapshot, options: RestoreOptions) {
    const frozen = this.validateSnapshot(snapshot);
    if (scope.account !== frozen.scope.account || scope.bookId !== frozen.scope.bookId || (scope.chatId !== frozen.scope.chatId && !options.allowRebind)) fail('MEMORY_SCOPE_MISMATCH','快照账号、书籍或聊天绑定不匹配');
    if (options.reincarnation && frozen.lineage !== 'original') fail('MEMORY_LINEAGE_INVALID','派生档不能再次轮回');
    return this.mutate(scope,options.requestId,{ kind: 'restore', hash: frozen.hash, reincarnation: !!options.reincarnation },options.expectedRevision,(data,sheet) => {
      const restored = clone(frozen.tableData[frozen.scope.sheetKey]) as OriginalGuideSheet;
      restored.uid = sheet.uid;
      restored.originalGuide = { ...clone(restored.originalGuide!), version: 2, scope: clone(scope), lineage: options.reincarnation ? 'derived' : frozen.lineage, requests: {} };
      data[scope.sheetKey] = restored; return stateFromData(data,scope).records.map(r => r.id);
    },true);
  }
  async recall(scope: MemoryScope, request: RecallRequest) {
    if (!request.requestId?.trim() || !request.generationIdentity?.trim() || typeof request.userInput !== 'string') fail('MEMORY_REQUEST_INVALID','缺少召回请求身份');
    const host = await assertMemoryHostScope_ACU(scope), initial = await this.read(scope);
    const frozen = request.source.kind === 'frozen' ? this.validateSnapshot(request.source.snapshot) : await this.snapshot(scope);
    if (frozen.scope.account !== scope.account || (request.source.kind === 'current' && frozen.scope.bookId !== scope.bookId)) fail('MEMORY_SCOPE_MISMATCH','冻结来源账号或本局书籍不一致');
    if (request.source.kind === 'frozen' && frozen.lineage !== 'original') fail('MEMORY_LINEAGE_INVALID','轮回只能引用原始来源快照');
    return recallOriginalGuideNative_ACU(frozen,request,() => { host.assertCurrent(true);
      if (stateFromData(tables(),scope).revision !== initial.revision) fail('MEMORY_CONTEXT_CHANGED','召回期间数据库版本变化'); });
  }
  subscribe(scope: MemoryScope, listener: (event: MemoryChange) => void) { const item={scope,listener}; subscribers.add(item); return () => subscribers.delete(item); }
  openSettings() { void getUiSurface_ACU()?.openSettings(); }
}
