import type { TableDataObject_ACU } from '../shared/models/table-data';
import type { OriginalGuideSheet } from './backend-contract';
import type { MemoryScope } from './memory-scope';
import { clone, columns, fail, stateFromData } from './memory-mapper';
import { originalGuideNote_ACU } from './original-guide-rules';
import { sha256HexSync_ACU } from '../shared/sha256-sync';

/** Read-only legacy import. Chat/manual facts have an explicit local provenance;
 * imported original-book rows require a declared node, never a guessed chapter. */
export function migrateLegacyMemory_ACU(template: TableDataObject_ACU, scope: MemoryScope, metadata: Record<string, any>, history?: any[]): TableDataObject_ACU {
  const legacy = metadata.xz_memory_v1;
  if (!legacy || legacy.version !== 1 || !Array.isArray(legacy.records)) fail('MEMORY_LEGACY_INVALID', '旧纪要结构无效');
  const sheet = clone(template[scope.sheetKey]) as OriginalGuideSheet, map = columns(sheet);
  sheet.content = [sheet.content[0]]; delete sheet.seedRows;
  sheet.sourceData.note = originalGuideNote_ACU(sheet.sourceData.note);
  sheet.originalGuide = { version: 2, scope: clone(scope), lineage: metadata.xz_reincarnation_v1?.kind === 'derived' ? 'derived' : 'original', requests: {}, rowNodeIds: {}, reservedRowIds: [] };
  const ids = new Set<string>();
  for (const [index, old] of legacy.records.entries()) {
    if (!old || typeof old.id !== 'string' || !old.id || ids.has(old.id) || ['code','time','summary','text','dialogue'].some(key => typeof old[key] !== 'string')) fail('MEMORY_LEGACY_INVALID', '旧纪要身份重复或字段损坏');
    ids.add(old.id);
    if (old.source?.kind === 'chat' && history) {
      const fingerprint = (message: any) => JSON.stringify([message?.mes, !!message?.is_user, !!message?.is_system, message?.swipe_id || 0]);
      const refs = old.source.refs;
      if (!Array.isArray(refs) || !refs.length || refs.some(ref => !Number.isSafeInteger(ref.index) || !history[ref.index] || sha256HexSync_ACU(fingerprint(history[ref.index])) !== ref.hash)
        || (old.source.historyHash && sha256HexSync_ACU(JSON.stringify(history.slice(0, refs[refs.length - 1].index + 1).map(fingerprint))) !== old.source.historyHash)) fail('MEMORY_SOURCE_CHANGED', '旧纪要 ' + old.code + ' 的来源楼层或 swipe 已变化，请先人工核对');
    }
    const declared = metadata.acu_original_guide_context_v2?.rowNodeIds;
    const node = declared?.[old.id] || declared?.[old.code] || (old.source?.kind === 'legacy_frozen' ? 'legacy-frozen' : ['chat','manual'].includes(old.source?.kind) ? 'local' : '');
    if (!node || typeof node !== 'string') fail('MEMORY_NODE_MAPPING_REQUIRED', '旧导入纪要 ' + old.code + ' 需要在 acu_original_guide_context_v2.rowNodeIds 中声明节点');
    const id = String(index + 1), row = Array(sheet.content[0].length).fill(''); row[0] = id;
    for (const key of ['code','time','summary','text','dialogue','location']) {
      const value = String(old[key] || '');
      if (map[key] < 0) { if (key === 'dialogue' && value) row[map.text] += '\n' + value; }
      else row[map[key]] = value;
    }
    sheet.content.push(row); sheet.originalGuide.rowNodeIds![id] = node; sheet.originalGuide.reservedRowIds!.push(id);
  }
  const data = { mate: clone(template.mate), [scope.sheetKey]: sheet } as TableDataObject_ACU;
  stateFromData(data, scope); return data;
}
