import { beforeEach, describe, expect, it, vi } from 'vitest';
import { data, scope } from './fixture';
import { digest, stateFromData } from '../../src/memory/memory-mapper';
const mocks = vi.hoisted(() => ({ settings: {} as any, loaded: null as any, execute: vi.fn(), transport: vi.fn(), dispose: vi.fn() }));
vi.mock('../../src/service/runtime/state-manager', () => ({ get settings_ACU() { return mocks.settings; } }));
vi.mock('../../src/service/template/chat-scope', () => ({ getCurrentChatPlotScopeState_ACU: () => null }));
vi.mock('../../src/service/plot/plot-logic', () => ({ getCurrentRuntimePlotPresetName_ACU: () => '', findPlotPresetByName_ACU: vi.fn(), applyPlotPresetToSettings_ACU: vi.fn(), normalizePlotTasks_ACU: (s: any) => s.plotTasks }));
vi.mock('../../src/service/ai/api-call', () => ({ callAIWithResolvedPreset_ACU: mocks.transport, requireResolvedApiPreset_ACU: vi.fn(), getApiConfigByPreset_ACU: () => ({ resolved: true, apiMode: 'custom', apiConfig: { url: 'https://example.invalid/v1', model: 'model' } }) }));
vi.mock('../../src/service/fill-mode/fill-mode-chat-record', () => ({ resolveCurrentChatFillMode_ACU: () => ({ mode: 'llm' }) }));
vi.mock('../../src/service/table/table-storage-strategy', () => ({ createDetachedSqlTableService_ACU: () => ({ loadFromData: async (d: any) => { mocks.loaded = structuredClone(d); return {}; }, isReady: () => true, getCurrentDataStrict_ACU: () => structuredClone(mocks.loaded), createReadNameMapper_ACU: () => ({}), dispose: mocks.dispose }) }));
vi.mock('../../src/service/runtime/plot-runtime/plot-task-engine', () => ({ runPlotTasksRuntime_ACU: mocks.execute }));
import { recallOriginalGuideNative_ACU } from '../../src/service/plot/original-guide-recall-adapter';
beforeEach(() => {
  mocks.settings = { plotSettings: { enabled: true, plotTasks: [{ id: 'recall', extractTags: 'recall', promptGroup: [{ role: 'user', content: 'native prompt one' }] }] } };
  mocks.dispose.mockReset(); mocks.transport.mockReset().mockResolvedValue('<recall>AM0001</recall>');
  mocks.execute.mockReset().mockImplementation(async (settings, _input, { requestContext }) => {
    await requestContext.callApi(settings.plotTasks[0].promptGroup, requestContext.resolveTaskApiPreset(settings.plotTasks[0]));
    return { failedResults: [], successfulResults: [{ extractedTags: { recall: 'AM0001', supplement: 'future advice' } }] };
  });
});
function fixture() {
  const tableData = data(); (tableData.sheet_memory as any).content.push(['8', 'future', '', 'future secret', 'future', 'AM0002']);
  (tableData.sheet_memory as any).originalGuide.rowNodeIds['8'] = 'future';
  const snapshot: any = { format: 'acu-original-guide-snapshot', schemaVersion: 2, scope, snapshotId: 'frozen', frozenAt: 1, tableData, history: [{ mes: 'future secret in raw dialogue' }], lineage: 'original', revision: stateFromData(tableData, scope).revision };
  snapshot.hash = digest(snapshot);
  const request: any = { requestId: 'r', generationIdentity: 'g', userInput: 'input', original: { bookId: 'b', currentNodeId: 'node-a', allowedNodeIds: ['node-a'], rowNodeIds: { '7': 'node-a', '8': 'future' }, rules: 'facts only' }, source: { kind: 'frozen', snapshot } };
  return { snapshot, request };
}
describe('native recall adapter handoff', () => {
  it('freezes filtered candidates consistently for SQL/EJS/history and uses the next edited native prompt', async () => {
    const { snapshot, request } = fixture(), original = structuredClone(snapshot);
    const first = await recallOriginalGuideNative_ACU(snapshot, request, () => {});
    const context = mocks.execute.mock.calls[0][2].requestContext;
    expect(context.controlledSource).toBe(true); expect(context.history).toEqual([]);
    expect(JSON.stringify(context.ejsContext.allTablesJson)).not.toContain('future secret');
    expect(context.sqlReadContext.tableData).toEqual(context.tableData);
    expect(first.records[0]).toMatchObject({ sourceScope: expect.any(String), snapshotId: 'frozen', stableRowId: '7' });
    expect(first.content).not.toContain('future advice'); expect(snapshot).toEqual(original);
    mocks.settings.plotSettings.plotTasks[0].promptGroup[0].content = 'native prompt two';
    const second = await recallOriginalGuideNative_ACU(snapshot, request, () => {});
    expect(mocks.transport.mock.calls[1][0][0].content).toBe('native prompt two'); expect(second.configRevision).not.toBe(first.configRevision);
    expect(mocks.dispose).toHaveBeenCalledTimes(2);
  });
  it('rejects partial native results and always disposes the detached reader', async () => {
    mocks.execute.mockResolvedValue({ failedResults: [{}], successfulResults: [{ extractedTags: { recall: 'AM0001' } }] });
    const { snapshot, request } = fixture();
    await expect(recallOriginalGuideNative_ACU(snapshot, request, () => {})).rejects.toThrow(/未全部完成/);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
