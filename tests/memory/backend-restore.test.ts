import { beforeEach, describe, expect, it, vi } from 'vitest';
import { data, scope } from './fixture';
import { digest, stateFromData } from '../../src/memory/memory-mapper';
const mocks = vi.hoisted(() => ({ current: null as any, server: null as any, failSave: false, commit: vi.fn(), mode: vi.fn() }));
vi.mock('../../src/service/runtime/state-manager', () => ({ get currentJsonTableData_ACU() { return mocks.current; } }));
vi.mock('../../src/data/gateways/memory-host-gateway', () => ({ assertMemoryHostScope_ACU: async () => ({ identity: { chatKey: 'chat' }, chat: [{ mes: 'story' }], assertCurrent: vi.fn() }), readMemoryAccount_ACU: async () => 'a' }));
vi.mock('../../src/data/gateways/chat-gateway', () => ({ readChatFromHostStrict_ACU: async () => [] }));
vi.mock('../../src/service/table/table-update-commit', () => ({ runTableUpdateCommit_ACU: mocks.commit }));
vi.mock('../../src/service/table/table-storage-strategy', () => ({ ensureStorageProviderReady_ACU: async () => {}, reloadStorageProvider: async () => ({ ok: true }) }));
vi.mock('../../src/service/table/storage-frame-v2-replay', () => ({ loadTableStateFromFramesV2Detailed_ACU: async () => ({ baseKind: 'full_checkpoint', data: structuredClone(mocks.server) }) }));
vi.mock('../../src/service/runtime/helpers-table-lock', () => ({ getTableLockIdentitiesForSheet_ACU: () => ({ hasAny: false }) }));
vi.mock('../../src/shared/ui-surface-registry', () => ({ getUiSurface_ACU: () => undefined }));
vi.mock('../../src/service/table/original-guide-fill-adapter', () => ({ fillOriginalGuideNative_ACU: vi.fn() }));
vi.mock('../../src/service/plot/original-guide-recall-adapter', () => ({ recallOriginalGuideNative_ACU: vi.fn(), captureOriginalGuidePlotConfig_ACU: vi.fn() }));
vi.mock('../../src/service/fill-mode/fill-mode-chat-switch', () => ({ setCurrentChatFillMode_ACU: mocks.mode }));
import { AcuMemoryBackend } from '../../src/memory/acu-memory-backend';
beforeEach(() => {
  mocks.current = data(); mocks.server = structuredClone(mocks.current); mocks.failSave = false;
  mocks.mode.mockReset().mockResolvedValue({ ok: true });
  mocks.commit.mockReset().mockImplementation(async (_options, apply) => {
    const result = await apply({ workingData: structuredClone(mocks.current), transactionContext: { assertFresh: vi.fn() } });
    if (mocks.failSave) return { success: false, error: 'save failed' };
    mocks.server = structuredClone(result.tableData); mocks.current = structuredClone(result.tableData);
    return { ...result, saved: true };
  });
});
describe('database restore receipt and lineage', () => {
  const backend = new AcuMemoryBackend();
  function snapshot(lineage: 'original' | 'derived' = 'original') {
    const payload = { format: 'acu-original-guide-snapshot' as const, schemaVersion: 2 as const, snapshotId: 'snapshot', frozenAt: 1,
      scope, revision: stateFromData(data(), scope).revision, tableData: data(), history: [], lineage };
    return { ...payload, hash: digest(payload) };
  }
  it('restores row provenance through the native commit and server readback, then deduplicates retry', async () => {
    const frozen = snapshot(), options = { requestId: 'restore', expectedRevision: digest(mocks.current.sheet_memory), allowRebind: true };
    const first = await backend.restore(scope, frozen, options);
    expect(first.status).toBe('committed');
    expect(stateFromData(mocks.server, scope).records[0].nodeId).toBe('node-a');
    expect((await backend.restore(scope, frozen, options)).status).toBe('deduplicated');
    const changed = snapshot('derived');
    await expect(backend.restore(scope, changed, options)).rejects.toThrow(/requestId/);
    await expect(backend.restore(scope, changed, { ...options, requestId: 'second', reincarnation: true })).rejects.toThrow(/派生档/);
  });
  it('does not confirm a failed native save or restore against a stale target revision', async () => {
    const frozen = snapshot(); mocks.failSave = true;
    await expect(backend.restore(scope, frozen, { requestId: 'failed', expectedRevision: digest(mocks.current.sheet_memory) })).rejects.toThrow(/save failed/);
    expect(mocks.server.sheet_memory.originalGuide.requests.failed).toBeUndefined();
    await expect(backend.restore(scope, frozen, { requestId: 'stale', expectedRevision: 'old' })).rejects.toThrow(/版本变化/);
  });
  it('saves editable business rules in the native sheet Note while selecting LLM mode', async () => {
    await backend.initialize(scope, 'bind');
    expect(mocks.mode).toHaveBeenCalledWith('llm');
    expect(mocks.server.sheet_memory.sourceData.note).toContain('[原著纪要业务规则 v2]');
  });
});
