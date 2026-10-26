import {describe,it,expect} from 'vitest';
import {assertMemoryScope,memoryScopeKey,memoryRecordIdentity} from '../../src/memory/memory-scope';
import {scope} from './fixture';
describe('memory source identity',()=>{
  it('includes account/chat/book/table/isolation without delimiter collisions',()=>{
    for(const field of ['account','chatId','bookId','sheetKey','isolationKey'] as const)expect(memoryScopeKey({...scope,[field]:'other'})).not.toBe(memoryScopeKey(scope));
    expect(memoryScopeKey({...scope,account:'a1:b',avatar:'c'})).not.toBe(memoryScopeKey({...scope,account:'a1',avatar:'b:c'}));
    expect(memoryRecordIdentity(scope,'7')).not.toBe(memoryRecordIdentity({...scope,chatId:'old'},'7'));
  });
  it('accepts the native default empty isolation slot but rejects missing identity',()=>{expect(()=>assertMemoryScope({...scope,isolationKey:''})).not.toThrow();expect(()=>assertMemoryScope({...scope,chatId:''})).toThrow();});
});
