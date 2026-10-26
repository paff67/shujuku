import { describe, it, expect } from 'vitest';
import { SqliteEngine } from '../../src/data/sqlite/sqlite-engine';
import { SyncBridge } from '../../src/data/sqlite/sync-bridge';
import { getPhysicalTableNameForSheet_ACU } from '../../src/shared/sheet-identity';
import { enforceOriginalGuideWrite_ACU } from '../../src/service/table/original-guide-fill-strategy';
import { stateFromData } from '../../src/memory/memory-mapper';
import { data, scope } from './fixture';
describe('parsed native SQLite original-guide write policy', () => {
  it('validates the exported parsed state and round-trips its same-commit receipt', async () => {
    let engine = new SqliteEngine(); await engine.init();
    try {
      let bridge = new SyncBridge(engine); const before = data();
      bridge.loadFromTableData(before, { strict: true });
      const table = getPhysicalTableNameForSheet_ACU(before, scope.sheetKey);
      engine.run(`INSERT INTO ${table} VALUES (8, 'next', '', 'new fact', 'new', 'AM0002')`);
      const after = bridge.exportToTableData(before.mate, { strict: true });
      expect(enforceOriginalGuideWrite_ACU(before, after, { scope, requestId: 'native', fingerprint: 'hash', operation: 'append', allowedColumns: [1,2,3,4,5] })).toBeNull();
      const revision = stateFromData(after, scope).revision;
      engine.dispose(); engine = new SqliteEngine(); await engine.init(); bridge = new SyncBridge(engine);
      bridge.loadFromTableData(after, { strict: true });
      const reloaded = bridge.exportToTableData(before.mate, { strict: true });
      expect(stateFromData(reloaded, scope).revision).toBe(revision);
      expect((reloaded.sheet_memory as any).originalGuide.requests.native.recordIds).toHaveLength(1);
    } finally { engine.dispose(); }
  });
});
