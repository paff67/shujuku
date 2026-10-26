import type { Sheet_ACU, TableDataObject_ACU } from '../shared/models/table-data';
import { parseDDLColumnNames } from '../shared/ddl-utils';
import { sha256HexSync_ACU } from '../shared/sha256-sync';
import { MemoryBackendError, type MemoryState, type OriginalGuideSheet } from './backend-contract';
import { memoryRecordIdentity, memoryScopeKey, type MemoryScope } from './memory-scope';
export function clone<T>(value: T): T { return structuredClone(value); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => (value as any)[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical((value as any)[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function digest(value: unknown): string { return sha256HexSync_ACU(canonical(value)); }
export function fail(code: string, message: string): never { throw new MemoryBackendError(code, message); }
const aliases: Record<string, string[]> = {
  code: ['code_index', 'code', '编码索引'], time: ['time_span', 'time', '时间跨度', '时间'],
  summary: ['summary', '概览', '概要'], text: ['chronicle_text', 'chronicle_entry', 'text', '纪要', '纪要正文'],
  dialogue: ['key_dialogue', 'dialogue', '重要对话'], location: ['location', '地点'],
};
export function columns(sheet: Sheet_ACU): Record<string, number> {
  if (!Array.isArray(sheet?.content?.[0]) || sheet.content[0][0] !== 'row_id') fail('MEMORY_SCHEMA_INVALID', '纪要表缺少稳定 row_id 首列');
  const physical = parseDDLColumnNames(sheet.sourceData?.ddl || '').map(v => v.replace(/^["\x60\[]|["\x60\]]$/g, ''));
  const header = sheet.content[0].map(String), out: Record<string, number> = {};
  for (const [field, names] of Object.entries(aliases)) {
    const matches = header.map((name, i) => names.includes(name) || (physical.length === header.length && names.includes(physical[i])) ? i : -1).filter(i => i >= 0);
    if (matches.length > 1) fail('MEMORY_SCHEMA_INVALID', '纪要列映射有歧义：' + field);
    out[field] = matches[0] ?? -1;
  }
  for (const field of ['code', 'time', 'summary', 'text']) if (out[field] < 1) fail('MEMORY_SCHEMA_INVALID', '纪要表缺少列：' + field);
  return out;
}
export function selectSheet(data: TableDataObject_ACU, key?: string): string {
  if (key) { columns(data[key] as Sheet_ACU); return key; }
  const keys = Object.keys(data).filter(k => k.startsWith('sheet_')).filter(k => { try { columns(data[k] as Sheet_ACU); return true; } catch { return false; } });
  if (keys.length !== 1) fail('MEMORY_SCHEMA_INVALID', '请明确选择纪要表；当前匹配 ' + keys.length + ' 张');
  return keys[0];
}
export function stateFromData(data: TableDataObject_ACU, scope: MemoryScope): MemoryState {
  const sheet = data[scope.sheetKey] as OriginalGuideSheet, map = columns(sheet);
  if (sheet.originalGuide && memoryScopeKey(sheet.originalGuide.scope) !== memoryScopeKey(scope)) fail('MEMORY_SCOPE_MISMATCH', '纪要表属于其他来源，请显式恢复并重新绑定');
  const rows = new Set<string>(), codes = new Set<string>();
  const records = sheet.content.slice(1).map(row => {
    const stableRowId = String(row[0] ?? '').trim(), code = String(row[map.code] ?? '').trim();
    if (!stableRowId || rows.has(stableRowId) || !/^AM\d+$/i.test(code) || codes.has(code.toUpperCase())) fail('MEMORY_RECORD_INVALID', '纪要 row_id 或 AM 编码为空、格式无效或重复');
    if (!String(row[map.text] ?? '').trim()) fail('MEMORY_RECORD_INVALID', '纪要正文不能为空');
    rows.add(stableRowId); codes.add(code.toUpperCase());
    return { id: memoryRecordIdentity(scope, stableRowId), stableRowId, code, nodeId: sheet.originalGuide?.rowNodeIds?.[stableRowId],
      time: String(row[map.time] ?? ''), summary: String(row[map.summary] ?? ''), text: String(row[map.text] ?? ''),
      dialogue: map.dialogue < 0 ? '' : String(row[map.dialogue] ?? ''), location: map.location < 0 ? '' : String(row[map.location] ?? '') };
  });
  return { version: 2, revision: digest({ scope, sheet }), records };
}
