import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ api: null as any, recall: vi.fn(), provider: null as any, current: true }));
vi.mock('../../src/shared/host-api', () => ({ get SillyTavern_API_ACU() { return mocks.api; } }));
vi.mock('../../src/data/gateways/memory-host-gateway', () => ({ captureMemoryHost_ACU: () => ({ identity: { chatId: 'a' }, history: 'same', chat: [{ is_user: true, mes: 'input' }], assertCurrent() { if (!mocks.current) throw Error('scope changed'); } }) }));
vi.mock('../../src/service/runtime/state-manager', () => ({ generationGate_ACU: { activeGenerations: [{ seq: 1 }] } }));
vi.mock('../../src/memory/generation-owner', () => ({ originalGuideOwnsGeneration_ACU: () => true, getOriginalGuideGenerationProvider_ACU: () => mocks.provider }));
vi.mock('../../src/memory/acu-memory-backend', () => ({ AcuMemoryBackend: class { recall(...args: any[]) { return mocks.recall(...args); } } }));
import { installOriginalGuideGeneration_ACU } from '../../src/presentation/bootstrap/original-guide-generation';
function eventSource() {
  const listeners = new Map<string, Function[]>();
  return { on(name: string, fn: Function) { listeners.set(name, [...(listeners.get(name) || []), fn]); }, async emit(name: string, ...args: any[]) {
    // Real host contract: listener errors are swallowed, outer gate must still reject.
    for (const fn of listeners.get(name) || []) { try { await fn(...args); } catch {} }
  } };
}
beforeEach(() => {
  mocks.current = true; mocks.api = { eventSource: eventSource(), eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'ready', CHAT_CHANGED: 'chat', GENERATION_STOPPED: 'stop' }, stopGeneration: vi.fn() };
  mocks.provider = { prepare: vi.fn(async () => ({ scope: {}, original: {} })), receive: vi.fn(async () => ({ content: 'business history' })), onState: vi.fn() };
  mocks.recall.mockReset().mockResolvedValue({ records: [], snapshotId: 'frozen', content: 'fact' });
  installOriginalGuideGeneration_ACU();
});
describe('outer original guide generation gate', () => {
  it('coalesces duplicate hook payloads and injects once before the final user entry', async () => {
    const payload = { messages: [{ role: 'user', content: 'input' }] };
    await Promise.all([mocks.api.eventSource.emit('ready', payload), mocks.api.eventSource.emit('ready', payload)]);
    expect(mocks.recall).toHaveBeenCalledTimes(1); expect(mocks.provider.receive).toHaveBeenCalledTimes(1);
    expect(payload.messages).toEqual([{ role: 'system', content: 'business history' }, { role: 'user', content: 'input' }]);
  });
  it('blocks generation and injects nothing when native recall fails, despite swallowed listener exceptions', async () => {
    mocks.recall.mockRejectedValue(Error('native failure'));
    const payload = { messages: [{ role: 'user', content: 'input' }] };
    await expect(mocks.api.eventSource.emit('ready', payload)).rejects.toThrow(/native failure/);
    expect(payload.messages).toHaveLength(1); expect(mocks.api.stopGeneration).toHaveBeenCalledOnce();
    expect(mocks.provider.onState).toHaveBeenLastCalledWith('failed', 'native failure');
  });
  it('cancels the shared source task on host stop and rejects the original send', async () => {
    mocks.recall.mockImplementation((_scope, request) => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))));
    const pending = mocks.api.eventSource.emit('ready', { messages: [] });
    const rejected = expect(pending).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(mocks.recall).toHaveBeenCalledOnce());
    await mocks.api.eventSource.emit('stop', 'host-id'); await rejected;
    expect(mocks.provider.receive).not.toHaveBeenCalled();
  });
});
