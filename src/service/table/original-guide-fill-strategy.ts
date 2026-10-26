import type { TableDataObject_ACU, Sheet_ACU } from '../../shared/models/table-data';
import type { OriginalGuideSheet } from '../../memory/backend-contract';
import { canonical, clone, columns, digest, fail, stateFromData } from '../../memory/memory-mapper';
import { memoryRecordIdentity, type MemoryScope } from '../../memory/memory-scope';
export interface OriginalGuideWriteStrategy_ACU {
  scope: MemoryScope; requestId: string; fingerprint: string;
  allowedColumns: number[]; operation: 'append';
}
export function originalGuideSheetKey_ACU(data: Record<string, any> | null): string | null {
  const keys = Object.keys(data || {}).filter(k => k.startsWith('sheet_') && data?.[k]?.originalGuide?.version === 2);
  if (keys.length > 1) fail('MEMORY_SCOPE_INVALID', '一个聊天只能绑定一张原著纪要表');
  return keys[0] || null;
}
/** Runs on parsed state inside the native commit lock, covering SQL/JSON/tools and retries. */
export function enforceOriginalGuideWrite_ACU(before: TableDataObject_ACU, after: TableDataObject_ACU,
  strategy?: OriginalGuideWriteStrategy_ACU): string | null {
  const key = strategy?.scope.sheetKey || originalGuideSheetKey_ACU(before);
  if (!key) return null;
  const previous = before[key] as OriginalGuideSheet, next = after[key] as OriginalGuideSheet;
  if (!previous || !next) return '原著纪要填表禁止删除或创建目标表';
  if (canonical(before.mate) !== canonical(after.mate)) return '原著纪要填表禁止修改全局配置';
  for (const other of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (other.startsWith('sheet_') && other !== key && canonical(before[other]) !== canonical(after[other])) return '原著纪要填表禁止越表写入';
  }
  const strip = (sheet: Sheet_ACU): unknown => ({ ...sheet, content: [] as any[][] });
  if (canonical(strip(previous)) !== canonical(strip(next))) return '原著纪要填表禁止修改表结构或配置';
  if (canonical(previous.content[0]) !== canonical(next.content[0])) return '原著纪要填表禁止修改表头';
  const rowMap = new Map(next.content.slice(1).map(row => [String(row[0]), row]));
  for (const row of previous.content.slice(1)) {
    if (canonical(rowMap.get(String(row[0]))) !== canonical(row)) return '原著纪要填表只允许追加，不得修改或删除既有纪要';
  }
  const allowed = new Set(strategy?.allowedColumns || Object.values(columns(previous)).filter(i => i > 0));
  const oldIds = new Set(previous.content.slice(1).map(row => String(row[0]))), seen = new Set<string>();
  for (const row of next.content.slice(1)) {
    const id = String(row[0] ?? '');
    if (!id || seen.has(id)) return '原著纪要 row_id 为空或重复';
    seen.add(id);
    if (oldIds.has(id)) continue;
    if (row.length !== next.content[0].length) return '原著纪要列数不匹配';
    if (row.some((value, index) => index > 0 && !allowed.has(index) && value !== '' && value !== null)) return '原著纪要填表写入了非业务列';
  }
  if (seen.size === oldIds.size) return '原著纪要填写必须至少追加一条非空纪要';
  if (previous.originalGuide) {
    next.originalGuide = clone(previous.originalGuide);
    next.originalGuide.rowNodeIds ||= {};
    for (const id of seen) if (!oldIds.has(id)) next.originalGuide.rowNodeIds[id] = 'local';
    next.originalGuide.reservedRowIds = [...new Set([...(previous.originalGuide.reservedRowIds || []), ...seen])];
  }
  if (strategy) {
    next.originalGuide = clone(previous.originalGuide || { version: 2, scope: strategy.scope, lineage: 'original', requests: {} });
    next.originalGuide.rowNodeIds ||= {};
    for (const id of seen) if (!oldIds.has(id)) next.originalGuide.rowNodeIds[id] = 'local';
    next.originalGuide.requests[strategy.requestId] = { fingerprint: strategy.fingerprint,
      recordIds: [...seen].filter(id => !oldIds.has(id)).map(id => memoryRecordIdentity(strategy.scope, id)) };
  }
  if (next.originalGuide) next.originalGuide.reservedRowIds = [...new Set([...(next.originalGuide.reservedRowIds || []), ...seen])];
  try { stateFromData(after, strategy?.scope || next.originalGuide!.scope); }
  catch (error) { return error instanceof Error ? error.message : '纪要数据无效'; }
  return null;
}
export function sourceFloorIdentity_ACU(message: any, index: number) {
  return { index, swipeId: Number(message?.swipe_id || 0), bodyHash: digest(String(message?.mes ?? '')) };
}
