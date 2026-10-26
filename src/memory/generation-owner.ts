import { captureMemoryHost_ACU } from '../data/gateways/memory-host-gateway';
import type { MemoryScope } from './memory-scope';
import type { MemorySnapshot, OriginalGuideContext, RecallReceipt } from './backend-contract';
import { originalGuideSheetKey_ACU } from '../service/table/original-guide-fill-strategy';
import { currentJsonTableData_ACU } from '../service/runtime/state-manager';
export interface OriginalGuideGenerationProvider_ACU {
  bookId: string;
  prepare(): Promise<{ scope: MemoryScope; original: OriginalGuideContext; anchor?: { snapshot: MemorySnapshot; original: OriginalGuideContext } }>;
  receive(receipts: RecallReceipt[]): void | { content: string } | Promise<void | { content: string }>;
  onState?(state: 'running' | 'complete' | 'failed', error?: string): void;
}
let provider: OriginalGuideGenerationProvider_ACU | null = null;
export function bindOriginalGuideGeneration_ACU(next: OriginalGuideGenerationProvider_ACU): () => void {
  if (!next?.bookId || typeof next.prepare !== 'function' || typeof next.receive !== 'function') throw new Error('原著生成桥接参数无效');
  provider = next; return () => { if (provider === next) provider = null; };
}
export function originalGuideOwnsGeneration_ACU(): boolean {
  try { return !!originalGuideSheetKey_ACU(currentJsonTableData_ACU) || !!provider && captureMemoryHost_ACU().identity.bookId === provider.bookId; } catch { return false; }
}
export function getOriginalGuideGenerationProvider_ACU() {
  if (!originalGuideOwnsGeneration_ACU() || !provider || captureMemoryHost_ACU().identity.bookId !== provider.bookId) throw new Error('此原著数据库缺少角色卡生成桥接，请加载配套转换脚本');
  return provider;
}
