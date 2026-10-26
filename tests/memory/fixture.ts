import type { MemoryScope } from '../../src/memory/memory-scope';
import type { TableDataObject_ACU } from '../../src/shared/models/table-data';
export const scope: MemoryScope = { account: 'a', isolationKey: 'slot', avatar: 'v', chatId: 'c', bookId: 'b', sheetKey: 'sheet_memory', schemaVersion: 1 };
export function data(): TableDataObject_ACU { return { mate: { type: 'acu_table_data', version: 3, updateConfigUiSentinel: 0,
  globalInjectionConfig: { readableEntryPlacement: {position:'before_char',depth:4,order:100},wrapperPlacement:{position:'before_char',depth:4,order:100} } }, sheet_memory: {
  uid:'memory', name:'纪要表', orderNo:0,
  sourceData:{note:'only happened facts',initNode:'',insertNode:'',updateNode:'',deleteNode:'',ddl:'CREATE TABLE chronicle (\n row_id INTEGER PRIMARY KEY,\n time_span TEXT, -- 时间跨度\n location TEXT, -- 地点\n chronicle_text TEXT, -- 纪要\n summary TEXT, -- 概览\n code_index TEXT UNIQUE -- 编码索引\n);'},
  content:[['row_id','时间跨度','地点','纪要','概览','编码索引'],['7','day','room','old fact','summary','AM0001']],
  updateConfig:{uiSentinel:0,contextDepth:0,updateFrequency:0,batchSize:0,skipFloors:0},exportConfig:{} as any,
  originalGuide:{version:2,scope,requests:{},lineage:'original',rowNodeIds:{'7':'node-a'}}
} as any }; }
