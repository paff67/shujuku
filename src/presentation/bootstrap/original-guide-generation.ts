import { SillyTavern_API_ACU } from '../../shared/host-api';
import { captureMemoryHost_ACU } from '../../data/gateways/memory-host-gateway';
import { generationGate_ACU } from '../../service/runtime/state-manager';
import { getOriginalGuideGenerationProvider_ACU, originalGuideOwnsGeneration_ACU } from '../../memory/generation-owner';
import { AcuMemoryBackend } from '../../memory/acu-memory-backend';
import { digest } from '../../memory/memory-mapper';
import { installHostEventWaitGate_ACU } from './plot-send-event-gate';
const installed = new WeakSet<object>();
const backend = new AcuMemoryBackend();
/** The outer emit gate propagates rejection even when the host swallows listener exceptions. */
export function installOriginalGuideGeneration_ACU() {
  const api = SillyTavern_API_ACU as any, source = api?.eventSource, events = api?.eventTypes;
  if (!source || installed.has(source) || !events?.CHAT_COMPLETION_SETTINGS_READY) return;
  installed.add(source);
  let controller: AbortController | null = null;
  const done = new WeakMap<object, Promise<void>>();
  const auxiliaryTag = '<acu-original-guide-aux-' + Math.random().toString(36).slice(2) + '>';
  source.on('js_generation_requested', (_id: unknown, type: string, config: any) => {
    if (!originalGuideOwnsGeneration_ACU() || !config) return;
    if (type === 'generateRaw') config.ordered_prompts = [{ role: 'system', content: auxiliaryTag }, ...(config.ordered_prompts || ['world_info_before','persona_description','char_description','char_personality','scenario','world_info_after','dialogue_examples','chat_history','user_input'])];
    else config.user_input = String(config.user_input || '') + auxiliaryTag;
  });
  const cancel = () => { controller?.abort(); controller = null; };
  if (events.GENERATION_STOPPED) source.on(events.GENERATION_STOPPED, cancel);
  if (events.CHAT_CHANGED) source.on(events.CHAT_CHANGED, cancel);
  for (const name of ['MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED']) if (events[name]) source.on(events[name], cancel);
  installHostEventWaitGate_ACU(source, events.CHAT_COMPLETION_SETTINGS_READY, async (data: any) => {
    let auxiliary = false;
    for (const message of data?.messages || []) {
      if (typeof message.content === 'string' && message.content.includes(auxiliaryTag)) { auxiliary = true; message.content = message.content.split(auxiliaryTag).join(''); }
    }
    if (auxiliary || !originalGuideOwnsGeneration_ACU() || ['quiet','impersonate'].includes(data?.type)) return;
    const prior = done.get(data); if (prior) return prior;
    const job = (async () => {
      if (controller) throw new Error('原著召回正在运行，请等待或停止现有任务');
      const provider = getOriginalGuideGenerationProvider_ACU();
      controller = new AbortController(); const active = controller;
      try {
        provider.onState?.('running');
        const host = captureMemoryHost_ACU();
        const prepared = await provider.prepare(); host.assertCurrent(true); active.signal.throwIfAborted();
        const user = [...host.chat].reverse().find(m => m.is_user && !m.is_system);
        if (!user) throw new Error('未找到本轮玩家楼层');
        const userInput = String(user.mes || ''), generation = generationGate_ACU.activeGenerations[generationGate_ACU.activeGenerations.length - 1];
        const identity = digest([host.identity, host.history, generation?.seq, user.swipe_id ?? 0, userInput]);
        const base = { requestId: identity + ':current', generationIdentity: identity, userInput, original: prepared.original, source: { kind: 'current' as const }, signal: active.signal };
        const receipts = [await backend.recall(prepared.scope, base)];
        if (prepared.anchor) {
          if (prepared.anchor.snapshot.lineage !== 'original') throw new Error('派生档不能作为第二次轮回的来源');
          receipts.push(await backend.recall(prepared.scope, { ...base, requestId: identity + ':anchor', original: prepared.anchor.original, source: { kind: 'frozen', snapshot: prepared.anchor.snapshot } }));
        }
        host.assertCurrent(true); active.signal.throwIfAborted();
        if (!Array.isArray(data.messages)) throw new Error('正文接口不支持聊天消息注入');
        const presentation = await provider.receive(receipts); host.assertCurrent(true); active.signal.throwIfAborted();
        const content = (presentation && presentation.content) ?? receipts.map(receipt => '<acu_recalled_history source="' + receipt.snapshotId + '">\n' + receipt.content + '\n</acu_recalled_history>').join('\n');
        let at = data.messages.length;
        for (let i=data.messages.length-1;i>=0;i--) if (data.messages[i].role === 'user') { at=i; break; }
        data.messages.splice(at,0,{ role: 'system', content });
        provider.onState?.('complete');
      } catch (error) { provider.onState?.('failed', error instanceof Error ? error.message : String(error)); api.stopGeneration?.(); throw error; }
      finally { if (controller === active) controller = null; }
    })(); done.set(data,job); return job;
  });
}
