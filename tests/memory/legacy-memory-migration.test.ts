import { describe, it, expect } from 'vitest';
import { migrateLegacyMemory_ACU } from '../../src/memory/legacy-memory-migration';
import { stateFromData } from '../../src/memory/memory-mapper';
import { data, scope } from './fixture';
const record = (kind = 'chat') => ({ id: 'legacy-1', code: 'AM0001', time: 'past', summary: 'summary', text: 'fact', dialogue: 'NPC: quote', source: { kind } });
describe('read-only legacy migration', () => {
  it('migrates established local facts without losing dialogue or writing the legacy package', () => {
    const metadata = { xz_memory_v1: { version: 1, records: [record()] } }, before = structuredClone(metadata);
    const migrated = migrateLegacyMemory_ACU(data(), scope, metadata);
    expect(stateFromData(migrated, scope).records[0]).toMatchObject({ stableRowId: '1', nodeId: 'local', text: 'fact\nNPC: quote' });
    expect(metadata).toEqual(before);
  });
  it('requires explicit node provenance for imported original-book material', () => {
    const metadata: any = { xz_memory_v1: { version: 1, records: [record('import')] } };
    expect(() => migrateLegacyMemory_ACU(data(), scope, metadata)).toThrow(/声明节点/);
    metadata.acu_original_guide_context_v2 = { rowNodeIds: { AM0001: 'future-node' } };
    expect(stateFromData(migrateLegacyMemory_ACU(data(), scope, metadata), scope).records[0].nodeId).toBe('future-node');
  });
  it('preserves derived lineage and refuses duplicate legacy identities', () => {
    const metadata = { xz_reincarnation_v1: { kind: 'derived' }, xz_memory_v1: { version: 1, records: [record()] } };
    expect((migrateLegacyMemory_ACU(data(), scope, metadata).sheet_memory as any).originalGuide.lineage).toBe('derived');
    metadata.xz_memory_v1.records.push(record());
    expect(() => migrateLegacyMemory_ACU(data(), scope, metadata)).toThrow(/重复/);
  });
  it('rejects legacy source references changed by a swipe', () => {
    const old = { ...record(), source: { kind: 'chat', refs: [{ index: 0, hash: 'different' }] } };
    expect(() => migrateLegacyMemory_ACU(data(), scope, { xz_memory_v1: { version: 1, records: [old] } }, [{ mes: 'changed' }])).toThrow(/swipe/);
  });
});
