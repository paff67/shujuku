import { MemoryBackendError } from './backend-contract';
export interface MemoryScope { account: string; isolationKey: string; avatar: string; chatId: string; bookId: string; sheetKey: string; schemaVersion: number; }
export function assertMemoryScope(scope: MemoryScope): void {
  for (const name of ['account', 'avatar', 'chatId', 'bookId', 'sheetKey'] as const) {
    if (typeof scope?.[name] !== 'string' || !scope[name].trim()) throw new MemoryBackendError('MEMORY_SCOPE_INVALID', '缺少记忆作用域：' + name);
  }
  if (typeof scope.isolationKey !== 'string') throw new MemoryBackendError('MEMORY_SCOPE_INVALID', '隔离槽必须为字符串，空串表示默认槽');
  if (scope.schemaVersion !== 1) throw new MemoryBackendError('MEMORY_SCOPE_INVALID', '不支持的记忆 schemaVersion');
}
export function memoryScopeKey(scope: MemoryScope): string {
  assertMemoryScope(scope);
  return 'm1:' + [scope.account, scope.isolationKey, scope.avatar, scope.chatId, scope.bookId, scope.sheetKey].map(v => v.length + ':' + v).join('');
}
export function memoryRecordIdentity(scope: MemoryScope, id: string): string { return memoryScopeKey(scope) + '#' + id.length + ':' + id; }
