import ts from 'typescript';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const source = process.env.ORIGINAL_GUIDE_SOURCE;
if (!source) throw new Error('Set ORIGINAL_GUIDE_SOURCE to the reviewed input script path.');
const output = process.env.ORIGINAL_GUIDE_OUTPUT
  || path.resolve('integrations/original-guide/live-current-script-native-llm.js');
const bridge = path.resolve('integrations/original-guide/bridge-runtime.js');
const expectedSha256 = '13B3DB9D4CA1C65EEB32FD96FD95FA59D7AB9E93A697D2DB7F903FB77585669C';

function findFunction(sourceText, name, secondParameter) {
  const file = ts.createSourceFile('card.js', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const nodes=[];
  const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text===name&&(!secondParameter||node.parameters[1]?.name?.text===secondParameter))nodes.push(node);ts.forEachChild(node,visit);};visit(file);
  if(nodes.length!==1)throw new Error('expected one function '+name+', got '+nodes.length);
  return [nodes[0].getStart(file),nodes[0].end];
}
function once(text, old, replacement) {
  if(text.split(old).length!==2)throw new Error('non-unique conversion anchor: '+old.slice(0,100));
  return text.replace(old,()=>replacement);
}

const input = await fs.readFile(source, 'utf8');
const hash = crypto.createHash('sha256').update(input).digest('hex').toUpperCase();
if (hash !== expectedSha256 && process.env.ALLOW_SOURCE_HASH_CHANGE !== '1') {
  throw new Error(`source SHA-256 changed: expected ${expectedSha256}, got ${hash}; set ALLOW_SOURCE_HASH_CHANGE=1 only after review`);
}
let replacement = await fs.readFile(bridge, 'utf8');
const memoryRange=findFunction(input,'installMemoryManager'),memorySource=input.slice(...memoryRange);
const businessStart=memorySource.indexOf('    const reincarnationDefault='),businessEnd=memorySource.indexOf('    async function configureCrossfire',businessStart);
if(businessStart<0||businessEnd<0)throw Error('business prompt anchors missing');
let business=memorySource.slice(businessStart,businessEnd);
business=once(business,"    function promptLibrary(kind='fill'){", "    function promptLibrary(kind='fill'){\n        if(['fill','recall','crossfire'].includes(kind))return {active:'native',profiles:[{id:'native',name:'数据库原生配置',prompt:[{role:'system',content:'请在数据库配置界面修改当前有效填表和剧情召回提示词。'}]}]};");
business=once(business,"    async function changePrompts(action,data,expected,kind='fill'){return exclusive(async()=>{", "    async function changePrompts(action,data,expected,kind='fill'){if(['fill','recall','crossfire'].includes(kind)){db().openSettings();return promptLibrary(kind);}return exclusive(async()=>{");
replacement=once(replacement,'  /* BUSINESS_PROMPTS */',business);
let result = input;
// Retain only pure legacy data migration/UI helpers, not the card's model protocol.
const recallCoreStart = result.indexOf('// Selection only: model IDs are checked against the original records before injection.');
const recallCoreEnd = result.indexOf('function installMemoryManager', recallCoreStart);
if (recallCoreStart < 0 || recallCoreEnd < 0) throw Error('legacy recall core anchors missing');
result = result.slice(0, recallCoreStart) + result.slice(recallCoreEnd);
result = once(result, 'window.XZ_MEMORY_CORE={fields,prompts,table,migrate,parseSql,messages};', 'window.XZ_MEMORY_CORE={fields,prompts,table,migrate};');
let replacements = 0;
for (const name of ['installMemoryManager', 'installRecallManager', 'installCrossfireManager']) {
  const [start, end] = findFunction(result, name);
  const body = findFunction(replacement, name);
  result = result.slice(0, start) + replacement.slice(body[0], body[1]) + result.slice(end);
  replacements += 1;
}
for (const name of ['parseSql', 'messages']) {
  const [start, end] = findFunction(result, name, name === 'messages' ? 'values' : undefined); result = result.slice(0, start) + result.slice(end);
}
// Full saves embed native schema/history/source identity; old packages are upgraded only as data.
const archiveHelpers = `
    function memoryContextFor(rows,snapshot,bookId){
        const fields=m=>[String(m.mes||''),!!m.is_user,!!m.is_system,m.swipe_id||0];
        const live=bookId===window.XZ_MEMORY.scope().book&&JSON.stringify(rows.slice(1).map(fields))===JSON.stringify(ctx().chat.map(fields));
        return window.XZ_MEMORY.originalContext(window.AutoCardUpdaterAPI.memory.snapshotRecords(snapshot),{bookId,metadata:rows[0].chat_metadata,live});
    }
    async function upgradeLegacyAnchor(metadata,scope){
        const value=validateLineage(metadata[LINEAGE]);if(value?.kind!=='derived'||value.anchor.memorySnapshot)return;
        const a=metadata[LINEAGE].anchor,memory=window.AutoCardUpdaterAPI.memory;
        const rows=[{chat_metadata:{xz_memory_v1:{version:1,records:a.records.map(row=>({...row,source:{kind:'legacy_frozen'}}))}}},{mes:'',is_user:false}];
        a.memorySnapshot=await memory.snapshotFromMessages(scope,rows,{bookId:a.bookId,chatId:'legacy-anchor:'+a.sourceId});
        a.originalContext=memoryContextFor(rows,a.memorySnapshot,a.bookId);
    }
`;
result=once(result,'    const pack=',archiveHelpers+'    const pack=');
result=once(result,"const pack=(id,title,rows,world,crossfire)=>({format:'xz-book-save',version:2,bookId:id.t.bookId,title,exportedAt:Date.now(),chat:clone(rows),world:cleanWorld(world),crossfire});", "const pack=async(id,title,rows,world,crossfire)=>{const memory=window.AutoCardUpdaterAPI.memory,scope=await memory.scope({bookId:window.XZ_MEMORY.scope().book,allowRebind:true}),memorySnapshot=await memory.snapshotFromMessages(scope,rows,{bookId:id.t.bookId,chatId:rows[0]?.chat_metadata?.xz_book_save?.id||id.chat});return {format:'xz-book-save',version:3,bookId:id.t.bookId,title,exportedAt:Date.now(),chat:clone(rows),world:cleanWorld(world),crossfire,memorySnapshot,memorySource:memorySnapshot.scope,memoryContext:window.XZ_MEMORY.originalContext(memory.snapshotRecords(memorySnapshot),{bookId:id.t.bookId,metadata:rows[0].chat_metadata})};};");
result=result.replace(/const bundle=pack\(/g,'const bundle=await pack(');
result=once(result,'![1,2].includes(b.version)','![1,2,3].includes(b.version)');
result=once(result,'        const validatedLineage=validateLineage(b.chat[0].chat_metadata[LINEAGE]);',"        const memoryApi=window.AutoCardUpdaterAPI.memory;\n        if(b.version<3){const scope=await memoryApi.scope({bookId:window.XZ_MEMORY.scope().book,allowRebind:true});b.memorySnapshot=await memoryApi.snapshotFromMessages(scope,b.chat,{bookId,chatId:b.chat[0].chat_metadata?.xz_book_save?.id||'legacy:'+b.exportedAt});b.memorySource=b.memorySnapshot.scope;b.memoryContext=window.XZ_MEMORY.originalContext(memoryApi.snapshotRecords(b.memorySnapshot),{bookId,metadata:b.chat[0].chat_metadata});b.version=3;}\n        memoryApi.validateSnapshot(b.memorySnapshot);if(b.memorySnapshot.scope.bookId!==bookId||!b.memoryContext||b.memoryContext.bookId!==bookId)throw Error('完整存档的数据库来源或节点上下文与书籍不一致');\n        const validatedLineage=validateLineage(b.chat[0].chat_metadata[LINEAGE]);");
result=once(result,"[['memory','配置纪要填写 API'],['recall','配置本局召回 API'],['anchorRecall','配置锚点召回 API'],['mvu','配置普通 MVU API'],['reincarnationMvu','配置轮回 MVU API']]", "[['mvu','配置普通 MVU API'],['reincarnationMvu','配置轮回 MVU API']]");
result=once(result,"item('recallEnabled','开启纪要召回','home',()=>window.XZ_RECALL?.config?.().enabled===true);", "item('recallEnabled','开启数据库原生召回','home',()=>window.XZ_RECALL?.config?.().enabled===true&&window.AutoCardUpdaterAPI?.memory?.capabilities().version==='2');");
const frozen=findFunction(result,'frozenRecords');
result=result.slice(0,frozen[0])+"async function frozenRecords(bundle){const api=window.AutoCardUpdaterAPI.memory;return api.snapshotRecords(api.validateSnapshot(bundle.memorySnapshot)).map(row=>Object.fromEntries(['id','code','time','summary','text','dialogue'].map(key=>[key,row[key]])));}"+result.slice(frozen[1]);
// Allow exactly one frozen source and its explicit context, never a nested anchor.
result=once(result,"...(Object.hasOwn(a||{},'crossfire')?['crossfire']:[])","...(Object.hasOwn(a||{},'crossfire')?['crossfire']:[]),...(Object.hasOwn(a||{},'memorySnapshot')?['memorySnapshot','originalContext']:[])");
result=once(result,"            if(Object.hasOwn(a,'crossfire')){", "            if(a.memorySnapshot){window.AutoCardUpdaterAPI.memory.validateSnapshot(a.memorySnapshot);if(a.memorySnapshot.lineage!=='original'||!a.originalContext)throw Error('轮回来源必须为单个完整原始快照');}\n            if(Object.hasOwn(a,'crossfire')){");
result=once(result,'frozenAt,records,crossfire:{version:1,indexes:[]}', 'frozenAt,records,memorySnapshot:clone(local.bundle.memorySnapshot),originalContext:clone(local.bundle.memoryContext),crossfire:{version:1,indexes:[]}');
// Materialize database first after opening the target chat; worldbook/MVU finalization follows its receipt.
result=once(result,'let file=reusable?.file,created=false,wrote=false,worldWritten=false,opened=false;', 'let file=reusable?.file,created=false,wrote=false,worldWritten=false,opened=false,databaseRestored=false;');
result=once(result,"            await guard();worldWritten=true;await mirrorWorld(id,metadata[KEY],world,{switching:true});\n            await guard();opened=true;await ctx().openCharacterChat(file);".replace(/\n/g,'\r\n'), "            await guard();opened=true;await ctx().openCharacterChat(file);\n            const memoryApi=window.AutoCardUpdaterAPI.memory,databaseTargetScope=await memoryApi.scope({bookId:id.t.bookId,allowRebind:true}),memorySnapshot=local?.bundle?.memorySnapshot;if(!memorySnapshot)throw Error('缺少完整数据库快照，请先升级存档');\n            const staged=await memoryApi.stageRestore(databaseTargetScope,memorySnapshot);\n            await memoryApi.restore(databaseTargetScope,memorySnapshot,{requestId:'load:'+uid,expectedRevision:staged.expectedRevision,allowRebind:true});databaseRestored=true;\n            worldWritten=true;await mirrorWorld(identity(id.t.bookId),metadata[KEY],world,{switching:true});");
result=once(result,'            // Roll back only our exact writes.',"            if(databaseRestored)throw Error('数据库已恢复，其余资源尚未完成；完整存档保留，请用同一存档重试：'+error.message);\n            // Roll back only our exact writes.");
result=once(result,'scope=await memory.scope({bookId:window.XZ_MEMORY.scope().book,allowRebind:true}),memorySnapshot=await memory.snapshotFromMessages', 'scope=await memory.scope({bookId:window.XZ_MEMORY.scope().book,allowRebind:true});await upgradeLegacyAnchor(rows[0].chat_metadata,scope);const memorySnapshot=await memory.snapshotFromMessages');
result=once(result,'memoryContext:window.XZ_MEMORY.originalContext(memory.snapshotRecords(memorySnapshot),{bookId:id.t.bookId,metadata:rows[0].chat_metadata})', 'memoryContext:memoryContextFor(rows,memorySnapshot,id.t.bookId)');
result=once(result,'b.memoryContext=window.XZ_MEMORY.originalContext(memoryApi.snapshotRecords(b.memorySnapshot),{bookId,metadata:b.chat[0].chat_metadata});', 'b.memoryContext=memoryContextFor(b.chat,b.memorySnapshot,bookId);await upgradeLegacyAnchor(b.chat[0].chat_metadata,scope);');
result=once(result,'        metadata.world_info=name;rows=clone(rows);', '        metadata.acu_original_guide_context_v2=clone(local?.bundle?.memoryContext||metadata.acu_original_guide_context_v2);\n        metadata.world_info=name;rows=clone(rows);');
const marker = 'ACU_ORIGINAL_GUIDE_NATIVE_LLM_V2';
if (!result.includes(marker)) {
  result = result.replace(
    '    const memory=installMemoryManager();',
    `    const memory=installMemoryManager();\n    // ${marker}: the database owns fill, native LLM recall, and generation injection.`,
  );
}
if (replacements !== 3 || !result.includes(marker) || result.includes("window.XZ_API.request('memory'")) {
  throw new Error('conversion postcondition failed: old card model protocol remains');
}
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, result);
await fs.writeFile(`${output}.manifest.json`, JSON.stringify({
  source: path.basename(source), sourceSha256: hash, output: path.basename(output), replacements, marker,
}, null, 2) + '\n');
console.log(JSON.stringify({ output, sourceSha256: hash, replacements, marker }));
