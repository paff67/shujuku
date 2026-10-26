import { SillyTavern_API_ACU } from '../../shared/host-api';
import { getHostRequestHeaders_ACU } from './ai-gateway';
import { getChatArray_ACU } from './chat-gateway';
import { currentChatFileIdentifier_ACU, getCurrentIsolationKey_ACU } from '../../service/runtime/state-manager';
import { digest, fail } from '../../memory/memory-mapper';
import type { MemoryScope } from '../../memory/memory-scope';

export function captureMemoryHost_ACU() {
  const api = SillyTavern_API_ACU;
  const context = typeof (api as any)?.getContext === 'function' ? (api as any).getContext() : api;
  const chat = getChatArray_ACU(), character = context?.characters?.[Number(context?.characterId)];
  if (!api || !context?.chatId || context.groupId || !character?.avatar || !chat.length || !currentChatFileIdentifier_ACU || currentChatFileIdentifier_ACU === 'unknown_chat_init') fail('MEMORY_SCOPE_INVALID', '请打开已初始化的单人聊天');
  const identity = { avatar: String(character.avatar), chatId: String(context.chatId), chatKey: String(currentChatFileIdentifier_ACU), isolationKey: getCurrentIsolationKey_ACU(), bookId: String(character.data?.extensions?.canon?.bookId || '') };
  const history = digest(chat.map(m => [m.mes, !!m.is_user, !!m.is_system, m.swipe_id ?? 0]));
  return { api, context, chat, identity, history, assertCurrent(checkHistory = false) {
    const current = typeof (SillyTavern_API_ACU as any)?.getContext === 'function' ? (SillyTavern_API_ACU as any).getContext() : SillyTavern_API_ACU;
    if (getChatArray_ACU() !== chat || String(current?.chatId) !== identity.chatId || current?.groupId || current?.characters?.[Number(current?.characterId)]?.avatar !== identity.avatar || currentChatFileIdentifier_ACU !== identity.chatKey || getCurrentIsolationKey_ACU() !== identity.isolationKey || (checkHistory && digest(chat.map(m => [m.mes, !!m.is_user, !!m.is_system, m.swipe_id ?? 0])) !== history)) fail('MEMORY_CONTEXT_CHANGED', '聊天、隔离槽或正文版本已变化，已停止旧任务');
  } };
}
export async function readMemoryAccount_ACU(): Promise<string> {
  const response = await fetch('/api/users/me', { credentials: 'same-origin', cache: 'no-store', headers: getHostRequestHeaders_ACU() });
  if (!response.ok) fail('MEMORY_ACCOUNT_UNAVAILABLE', '无法确认记忆所属账号（HTTP ' + response.status + '）');
  const value = await response.json();
  if (typeof value?.handle !== 'string' || !value.handle.trim()) fail('MEMORY_ACCOUNT_UNAVAILABLE', '宿主未返回账号 handle');
  return value.handle;
}
export async function assertMemoryHostScope_ACU(scope: MemoryScope) {
  const host = captureMemoryHost_ACU(), account = await readMemoryAccount_ACU(); host.assertCurrent();
  if (scope.account !== account || scope.isolationKey !== host.identity.isolationKey || scope.avatar !== host.identity.avatar || scope.chatId !== host.identity.chatId || (host.identity.bookId && host.identity.bookId !== scope.bookId)) fail('MEMORY_SCOPE_MISMATCH', '记忆请求不属于当前账号、角色、书籍或聊天');
  return host;
}
