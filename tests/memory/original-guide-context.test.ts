import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Execute the actual bridge function embedded by the card converter.
const source = readFileSync('integrations/original-guide/bridge-runtime.js', 'utf8');
const file = ts.createSourceFile('bridge.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let declaration: ts.FunctionDeclaration;
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'originalContext') declaration = node;
  ts.forEachChild(node, visit);
}
visit(file);
const makeContext = new Function('ctx', 'copy', 'scope', 'TavernHelper',
  `${source.slice(declaration.getStart(file), declaration.end)}; return originalContext;`);
const configured = { bookId: 'book', currentNodeId: 'past', allowedNodeIds: ['local', 'past'],
  rowNodeIds: { old: 'past' }, rules: 'custom rules' };
function fixture(nodes = ['past', 'now']) {
  const metadata = { acu_original_guide_context_v2: structuredClone(configured) };
  const context = { chatMetadata: metadata, chat: nodes.map(() => ({})) };
  const resolve = makeContext(() => context, structuredClone, () => ({ book: 'book' }), {
    getVariables: ({ message_id }: { message_id: number }) => ({ canon_cursor: { start: nodes[message_id] } }),
  });
  return { resolve, metadata, context };
}
const rows = [{ code: 'AM1', stableRowId: '1', nodeId: 'now' }];
describe('original guide live versus frozen node context', () => {
  it('refreshes configured context on every generation without mutating saved boundaries', () => {
    const nodes = ['past', 'now'];
    const { resolve, context, metadata } = fixture(nodes);
    expect(resolve(rows)).toMatchObject({ currentNodeId: 'now', allowedNodeIds: ['local', 'past', 'now'],
      rowNodeIds: { '1': 'now' }, rules: 'custom rules' });
    nodes.push('next'); context.chat.push({});
    expect(resolve(rows).currentNodeId).toBe('next');
    expect(metadata.acu_original_guide_context_v2).toEqual(configured);
  });
  it('refreshes an active-chat export but leaves a frozen archive independent of live cursors', () => {
    const { resolve, metadata } = fixture();
    expect(resolve(rows, { bookId: 'book', metadata, live: true }).currentNodeId).toBe('now');
    expect(resolve(rows, { bookId: 'book', metadata })).toMatchObject({ currentNodeId: 'past',
      allowedNodeIds: ['local', 'past'], rowNodeIds: { '1': 'now' } });
  });
  it('does not allow a future row merely because it is present in the database', () => {
    const { resolve } = fixture();
    const result = resolve([...rows, { code: 'AM2', stableRowId: '2', nodeId: 'future' }]);
    expect(result.allowedNodeIds).not.toContain('future');
    expect(result.rowNodeIds['2']).toBe('future');
  });
  it('retains an explicit cursor when no message cursor is available', () => {
    expect(fixture([]).resolve(rows).currentNodeId).toBe('past');
  });
  it('derives unconfigured live context and refuses to guess missing archive boundaries', () => {
    const { resolve, context } = fixture();
    delete context.chatMetadata.acu_original_guide_context_v2;
    expect(resolve(rows)).toMatchObject({ currentNodeId: 'now', allowedNodeIds: ['local', 'legacy-frozen', 'past', 'now'] });
    expect(() => resolve(rows, { bookId: 'book', metadata: {} })).toThrow(/冻结原著节点边界/);
  });
  it('rejects records without provenance', () => {
    expect(() => fixture().resolve([{ code: 'AM1', stableRowId: '1' }])).toThrow(/缺少节点来源/);
  });
});
