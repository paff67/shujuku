import { extractNativeRecallCodes_ACU } from '../../shared/native-recall-codes';
import { fail } from '../../memory/memory-mapper';
import type { MemoryRecord, OriginalGuideContext } from '../../memory/backend-contract';
/** Filter before prompt assembly AND validate again during expansion. */
export function filterOriginalGuideCandidates_ACU(records: MemoryRecord[], context: OriginalGuideContext): MemoryRecord[] {
  if (!context?.currentNodeId || !Array.isArray(context.allowedNodeIds) || !context.allowedNodeIds.includes(context.currentNodeId)) fail('MEMORY_NODE_MAPPING_REQUIRED', '缺少当前节点及允许节点映射');
  const allowed = new Set(context.allowedNodeIds);
  return records.filter(record => {
    const node = context.rowNodeIds?.[record.stableRowId];
    if (!node) fail('MEMORY_NODE_MAPPING_REQUIRED', '纪要缺少节点映射：' + record.stableRowId);
    return allowed.has(node);
  });
}
/** Consume native extracted <recall> only; supplement/plot/directive are never historical facts. */
export function exportNativePlotRecall_ACU(results: any[], candidates: MemoryRecord[]): MemoryRecord[] {
  const recall = results.flatMap(result => Object.entries(result?.extractedTags || {}).filter(([tag]) => tag.toLowerCase() === 'recall').map(([,value]) => String(value)));
  if (!recall.length) fail('MEMORY_PRESET_INCOMPATIBLE', '当前数据库剧情预设未导出独立 recall 标签，请在数据库配置界面配置原生召回标签');
  const codes = extractNativeRecallCodes_ACU(recall.join('\n')), available = new Map(candidates.map(r => [r.code.toUpperCase(), r]));
  if (codes.some(code => !available.has(code))) fail('MEMORY_RECALL_SOURCE_INVALID', '原生召回包含不属于本次候选来源的编码');
  return codes.map(code => available.get(code)!);
}
