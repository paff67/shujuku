import type { MemoryScope } from './memory-scope';
import type { Sheet_ACU, TableDataObject_ACU } from '../shared/models/table-data';
export class MemoryBackendError extends Error {
  readonly name = 'MemoryBackendError';
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); }
}
export interface MemoryRecord {
  id: string; stableRowId: string; code: string; time: string; summary: string; text: string;
  dialogue: string; location?: string; nodeId?: string;
}
export type MemoryRecordPatch = Partial<Pick<MemoryRecord, 'code' | 'time' | 'summary' | 'text' | 'dialogue' | 'location'>>;
export interface MemoryState { version: 2; revision: string; records: MemoryRecord[]; }
export interface CommitReceipt {
  requestId: string; scopeKey: string; revision: string; status: 'committed' | 'deduplicated'; recordIds: string[];
}
export interface MemorySnapshot {
  format: 'acu-original-guide-snapshot'; schemaVersion: 2; snapshotId: string; scope: MemoryScope;
  frozenAt: number; revision: string; tableData: TableDataObject_ACU;
  history: Record<string, any>[]; lineage: 'original' | 'derived'; hash: string;
}
export interface SourceFloorIdentity { index: number; swipeId: number; bodyHash: string; }
export interface FillRequest {
  requestId: string; sourceFloors: SourceFloorIdentity[]; targetSheetKey: string;
  operation: 'explicit_refill'; expectedRevision: string; signal?: AbortSignal;
}
/** Explicit node membership permits original-book facts; no chapter/time guessing. */
export interface OriginalGuideContext {
  bookId: string; currentNodeId: string; allowedNodeIds: string[];
  rowNodeIds: Record<string, string>; rules: string;
}
export interface RecallRequest {
  requestId: string; generationIdentity: string; userInput: string; original: OriginalGuideContext;
  source: { kind: 'current' } | { kind: 'frozen'; snapshot: MemorySnapshot }; signal?: AbortSignal;
}
export interface RecallReceipt {
  requestId: string; generationIdentity: string; revision: string; configRevision: string;
  sourceScope: MemoryScope; snapshotId: string;
  records: (MemoryRecord & { sourceScope: string; snapshotId: string })[]; content: string;
}
export interface RestoreOptions { requestId: string; expectedRevision: string; allowRebind?: boolean; reincarnation?: boolean; }
export interface MemoryChange { scopeKey: string; revision: string; kind: 'committed' | 'invalidated'; recordIds: string[]; }
export interface OriginalGuideSheetMetadata {
  version: 2; scope: MemoryScope; lineage: 'original' | 'derived';
  rowNodeIds?: Record<string, string>; reservedRowIds?: string[];
  requests: Record<string, { fingerprint: string; recordIds: string[] }>;
}
export type OriginalGuideSheet = Sheet_ACU & { originalGuide?: OriginalGuideSheetMetadata };
