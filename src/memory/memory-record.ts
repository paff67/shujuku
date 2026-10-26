export type { MemoryRecord, MemoryRecordPatch } from './backend-contract';
export interface MemoryRecordSourceRef { index: number; swipeId: number; bodyHash: string; }
export interface MemoryRecordSource { kind: 'chat'|'snapshot'; refs?: MemoryRecordSourceRef[]; sourceScope?: string; snapshotId?: string; }
