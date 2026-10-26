import { bindOriginalGuideGeneration_ACU } from '../../../memory/generation-owner';
import { AcuMemoryBackend, invalidateMemoryBackend_ACU } from '../../../memory/acu-memory-backend';
import type { ApiGroupContext } from './callback-api';
import type { MemoryScope } from '../../../memory/memory-scope';
import type { MemoryChange } from '../../../memory/backend-contract';
const backend = new AcuMemoryBackend();
export function createMemoryApi(ctx: ApiGroupContext): Record<string, unknown> {
  ctx.tableUpdateCallbacks.push(() => invalidateMemoryBackend_ACU());
  return { memory: Object.freeze({
    bindGeneration: bindOriginalGuideGeneration_ACU, capabilities: () => backend.capabilities(), scope: (options: { bookId: string; sheetKey?: string; allowRebind?: boolean }) => backend.resolveScope(options),
    ready: backend.ready.bind(backend), read: backend.read.bind(backend), insert: backend.insert.bind(backend), update: backend.update.bind(backend), remove: backend.remove.bind(backend),
    fill: backend.fill.bind(backend), recall: backend.recall.bind(backend), snapshotRecords: backend.snapshotRecords.bind(backend), snapshot: backend.snapshot.bind(backend), validateSnapshot: backend.validateSnapshot.bind(backend), restore: backend.restore.bind(backend), stageRestore: backend.stageRestore.bind(backend),
    initialize: backend.initialize.bind(backend), snapshotFromMessages: backend.snapshotFromMessages.bind(backend), settings: backend.settings.bind(backend), sourceFloors: backend.sourceFloors.bind(backend), subscribe: (scope: MemoryScope, listener: (event: MemoryChange) => void) => backend.subscribe(scope, listener), openSettings: () => backend.openSettings(),
  }) };
}
