/* Replaces card memory/recall managers. Database owns AI requests and final generation injection. */
function installMemoryManager() {
  if (window.XZ_MEMORY?.version === 2) return window.XZ_MEMORY;
  window.XZ_MEMORY?.destroy?.();
  const ctx=()=>SillyTavern.getContext(),copy=structuredClone,core=window.XZ_MEMORY_CORE,SETTINGS='xz_memory_settings_v1';
  const uuid=()=>crypto.randomUUID(),equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  let cache=null,cacheScope='',busy=false,controller=null,failedFill=null,progress='',dead=false,retryStorage='';
  const db=()=>{const api=window.AutoCardUpdaterAPI?.memory;if(api?.capabilities().version!=='2')throw Error('请先安装配套数据库 v2 原生桥接构建');return api;};
  function scope(){const c=ctx(),ch=c.characters?.[c.characterId];if(c.groupId||!c.chatId||!ch?.data?.extensions?.canon?.bookId)throw Error('请打开本书单人聊天');return {avatar:ch.avatar,chat:c.chatId,book:ch.data.extensions.canon.bookId};}
  const bindings=new Map();
  async function nativeScope(allowRebind=false){const target=await db().scope({bookId:scope().book,allowRebind});if(allowRebind)return target;const key=JSON.stringify(target);if(!bindings.has(key))bindings.set(key,(async()=>{const ready=await db().ready(target);if(!ready.ok)throw Error(ready.reason);if(!ready.bound){const legacy=ctx().chatMetadata?.xz_memory_v1;if(legacy){const snapshot=await db().snapshotFromMessages(target,[{chat_metadata:copy(ctx().chatMetadata)},...copy(ctx().chat)]),staged=await db().stageRestore(target,snapshot);await db().restore(target,snapshot,{requestId:'legacy-bind:'+snapshot.hash,expectedRevision:staged.expectedRevision});}await db().initialize(target,'original-guide-bind-v2',ctx().chatMetadata?.acu_original_guide_context_v2?.rowNodeIds||{});}})().catch(e=>{bindings.delete(key);throw e;}));await bindings.get(key);return target;}
  function check(s){if(dead||!equal(s,scope()))throw Error('聊天已切换');controller?.signal.throwIfAborted();}
  function emit(text){progress=text||progress;window.dispatchEvent(new Event('xz-memory-changed'));}
  async function view(){const s=scope(),target=await nativeScope(),state=await db().read(target);check(s);cache={...state,imports:[],config:{batch:1}};cacheScope=JSON.stringify(s);return copy(cache);}
  function read(){if(!cache||cacheScope!==JSON.stringify(scope()))throw Error('数据库正在加载，请稍后重新打开');return copy(cache);}
  async function exclusive(fn){if(busy)throw Error('数据库桥接任务正在运行');busy=true;controller=new AbortController();try{return await fn();}finally{busy=false;controller=null;emit();}}
  function settings(){return copy(ctx().extensionSettings?.[SETTINGS]||{version:1,books:{},batch:1,enabled:true,recall:{enabled:true},automatic:{enabled:false}});}
  async function saveSettings(next,expected){if(!equal(settings(),expected))throw Error('业务设置已变化');return window.XZ_API.saveMemorySettings(next,copy(ctx().extensionSettings?.[SETTINGS]??null));}
  /* BUSINESS_PROMPTS */
  const openDatabase=()=>{db().openSettings();return settings();};
  const configure=openDatabase,configureRecall=openDatabase,configureCrossfire=openDatabase,setWriting=openDatabase;
  function writing(){return {enabled:true,autoEnabled:false,every:1,start:1,status:'自动填写和提示词由数据库设置管理'};}
  const dbTables=()=>window.AutoCardUpdaterAPI.exportTableAsJson(),dbPrompts=()=>[];
  async function loadRetry(){const target=await nativeScope(),key='acu-original-guide-fill-v2:'+JSON.stringify(target);if(retryStorage!==key){retryStorage=key;failedFill=JSON.parse(localStorage.getItem(key)||'null');}if(failedFill&&!equal(failedFill.scope,target))throw Error('填写重试不属于当前来源');return target;}
  function saveFailure(value){if(value){const raw=JSON.stringify(value);localStorage.setItem(retryStorage,raw);if(localStorage.getItem(retryStorage)!==raw)throw Error('填写重试身份保存失败');}else localStorage.removeItem(retryStorage);failedFill=value;}
  async function edit(record,id,expected){return exclusive(async()=>{const target=await nativeScope(),state=await db().read(target),old=state.records.find(r=>r.id===id);if(id&&!equal(old,expected))throw Error('纪要已变化，请重新读取');const values=record&&Object.fromEntries(['code','time','summary','text','dialogue','location'].filter(k=>record[k]!==undefined).map(k=>[k,String(record[k])]));if(record===null)await db().remove(target,id,uuid(),state.revision);else if(id)await db().update(target,id,values,uuid(),state.revision);else await db().insert(target,values,uuid());return view();});}
  async function plan({start=1,end=ctx().chat.length,latest=false}={}){const refs=await db().sourceFloors(start-1,end);const selected=latest?refs.slice(-1):refs;return {total:selected.length,pending:selected.length,skipped:0,requests:selected.length?1:0,batches:selected.length?[selected.map(ref=>({start:ref.index,end:ref.index}))]:[]};}
  async function fill(options={}){return exclusive(async()=>{const target=await loadRetry(),state=await db().read(target);let refs=options.request?.sourceFloors||await db().sourceFloors((options.start||1)-1,options.end||ctx().chat.length);if(options.latest)refs=refs.slice(-1);if(!refs.length)return {added:0,skipped:0};const request=options.request||{requestId:uuid(),sourceFloors:refs,targetSheetKey:target.sheetKey,operation:'explicit_refill',expectedRevision:state.revision};saveFailure({scope:target,request,error:'原生填写未完成'});emit('数据库正在补齐纪要…');try{const receipt=await db().fill(target,{...request,signal:controller.signal});saveFailure(null);await view();return {added:receipt.recordIds.length,skipped:receipt.status==='deduplicated'?refs.length:0};}catch(e){saveFailure({scope:target,request,error:e.message});emit(e.message);throw e;}});}
  async function retryFill(){await loadRetry();if(!failedFill)throw Error('没有待重试填写');return fill({request:failedFill.request});}
  async function migrate(name,mapping,data){return exclusive(async()=>{const target=await nativeScope(),before=await db().read(target),plan=core.migrate(data||dbTables(),name,mapping,before.records);if(!mapping?.nodeId)throw Error('导入原著资料需要显式 nodeId，不能按章节或时间猜测');let added=0;for(const row of plan.records){const record=Object.fromEntries(['code','time','summary','text','dialogue'].map(k=>[k,String(row[k]||'')]));await db().insert(target,record,'import:'+name+':'+row.code,mapping.nodeId);added++;}await view();return {added,duplicate:plan.duplicate,total:plan.total};});}
  async function reviseOpening(plan,expected,{preview=false}={}){if(ctx().chat.length!==1)throw Error('已有正文，不能改写开局前情');if(!equal(await view(),expected))throw Error('纪要已变化');if(!plan?.nodeId)throw Error('开局前情需要显式节点映射');if(preview)return {removed:0,added:core.migrate({opening:plan.table},'opening',plan.mapping||{},[]).records.length};return migrate('opening',{...plan.mapping,nodeId:plan.nodeId},{opening:plan.table});}
  function originalContext(records,archive){
    const configured=(archive?.metadata||ctx().chatMetadata)?.acu_original_guide_context_v2;
    const rowNodeIds={};for(const row of records){if(!row.nodeId)throw Error('纪要 '+row.code+' 缺少节点来源；请先在迁移参数中提供 nodeId');rowNodeIds[row.stableRowId]=row.nodeId;}
    if(configured)return {...copy(configured),rowNodeIds};
    const nodes=new Set(['local','legacy-frozen']);let current='local';
    if(!archive||archive.live)for(let i=0;i<ctx().chat.length;i++){const cursor=TavernHelper.getVariables({type:'message',message_id:i})?.canon_cursor;if(cursor?.start){nodes.add(cursor.start);current=cursor.start;}}
    if(archive&&!archive.live&&records.some(row=>!nodes.has(row.nodeId)))throw Error('此旧档缺少冻结原著节点边界，请先声明 acu_original_guide_context_v2 后升级');
    return {bookId:archive?.bookId||scope().book,currentNodeId:current,allowedNodeIds:[...nodes],rowNodeIds,rules:'只把候选纪要视为已发生事实。原著游标之外的后续剧情不是本局历史。'};
  }
  const api=window.XZ_MEMORY={version:2,read,view,scope,nativeScope,originalContext,settings,bookPrompt,reincarnationOpeningPrompt,reincarnationPolishPrompt,promptLibrary,changePrompts,
    builtinPrompt:kind=>kind==='reincarnationMvu'?copy(reincarnationMvuDefault):kind==='reincarnationPolish'?copy(reincarnationPolishDefault):kind==='reincarnation'?copy(reincarnationDefault):[],
    configure,configureRecall,configureCrossfire,setWriting,writing,dbTables,dbPrompts,edit,migrate,reviseOpening,plan,fill,retry:retryFill,loadRetry,apiId:()=>'',
    get failure(){return failedFill&&copy(failedFill);},get busy(){return busy;},get progress(){return progress;},stop(){controller?.abort();},destroy(){dead=true;controller?.abort();if(window.XZ_MEMORY===api)delete window.XZ_MEMORY;}};
  void view().then(()=>emit()).catch(e=>emit(e.message));return api;
}
function installRecallManager(){
  window.XZ_RECALL?.destroy?.();
  const mem=window.XZ_MEMORY,ctx=()=>SillyTavern.getContext(),db=window.AutoCardUpdaterAPI?.memory;
  if(db?.capabilities().version!=='2')throw Error('数据库 v2 原生桥接未安装');
  let receipts=[],last=null,status='',dead=false,busy=false,pending=null;
  const emit=()=>window.dispatchEvent(new Event('xz-recall-changed'));
  const unbind=db.bindGeneration({bookId:mem.scope().book,onState(state,error){busy=state==='running';status=error||(busy?'数据库原生 LLM 召回中':status);pending=state==='failed'?{status:'failed',error}:null;emit();},async prepare(){
    status='数据库原生 LLM 召回中';emit();const scope=await mem.nativeScope(),state=await db.read(scope),original=mem.originalContext(state.records),lineage=window.XZ_SAVE_MANAGER?.lineage();
    let anchor;
    if(lineage?.kind==='derived'){
      const snapshot=db.validateSnapshot(lineage.anchor.memorySnapshot),rows=db.snapshotRecords(snapshot);
      const original=lineage.anchor.originalContext;
      if(!original)throw Error('轮回来源缺少冻结节点上下文，请重新从 v3 完整存档创建');
      anchor={snapshot,original};
    }
    return {scope,original,anchor};
  },async receive(values){
    if(dead)throw Error('角色卡桥接已关闭');receipts=structuredClone(values);
    const identity=values.length>1?ctx().chatMetadata?.xz_reincarnation_mvu_v1:null,names=identity?createReincarnationMvuCore():null;
    if(values.length>1&&!identity)throw Error('轮回 MVU 身份缺失');
    const groups=values.map((value,i)=>({id:i?'anchor':'current',label:i?'轮回记忆':'本局记忆',records:i?names.recallRecords(value.records,identity):value.records,...(i?{identities:names.recallIdentities(identity)}:{})}));
    const row=[...ctx().chat].reverse().find(m=>m.is_user&&!m.is_system);
    last={version:1,at:Date.now(),requestKey:values[0].generationIdentity,groups};
    if(row){last.userSignature=JSON.stringify([String(row.mes||''),row.swipe_id??0,!!row.is_system]);row.extra={...row.extra,xz_recall_injection_v1:structuredClone(last)};await ctx().saveChat();}
    status='已召回 '+values.reduce((n,v)=>n+v.records.length,0)+' 条';emit();window.dispatchEvent(new Event('xz-recall-injection-changed'));
    const identityNote=identity?'轮回来源名册中 owner=user 指向本局玩家，历史姓名不是第二个玩家；owner=historical-only 的人物未携带，不得据此创建或更新其 MVU。\n'+JSON.stringify({reincarnation_history_identities:names.recallIdentities(identity)})+'\n':'';
    return {content:identityNote+groups.map((group,i)=>'<acu_recalled_history source="'+values[i].snapshotId+'">\n'+group.records.map(r=>'['+r.sourceScope+'/'+r.snapshotId+'/'+r.stableRowId+'] '+r.code+' '+r.time+'\n'+r.summary+'\n'+r.text+(r.dialogue?'\n'+r.dialogue:'')).join('\n\n')+'\n</acu_recalled_history>').join('\n')};
  }});
  function injectionAt(mid){const row=ctx().chat[mid],value=row?.extra?.xz_recall_injection_v1;return row?.is_user&&value?.userSignature===JSON.stringify([String(row.mes||''),row.swipe_id??0,!!row.is_system])?structuredClone(value):null;}
  const api=window.XZ_RECALL={config:()=>({enabled:true}),configure:()=>db.openSettings(),state:()=>({busy,status,pending,enabled:true}),get busy(){return busy;},load:async()=>{},results:async()=>(last?.groups||[]).flatMap(v=>v.records),injectionAt,injections:()=>ctx().chat.flatMap((m,mid)=>{const v=injectionAt(mid);return v?[{mid,...v}]:[];}),latestInjection:()=>last,retry:()=>ctx().generate('normal'),destroy(){dead=true;unbind();if(window.XZ_RECALL===api)delete window.XZ_RECALL;}};return api;
}
/** Legacy archive compatibility only. No embeddings, reranker, recall or IndexedDB runtime. */
function installCrossfireManager(){
  const empty=()=>({version:1,indexes:[]});
  const api={defaults:{enabled:false},defaultPrompt:[],config:()=>({enabled:false}),snapshot:()=>null,
    validate:()=>true,validateArchive:async pack=>{if(pack?.version!==1||!Array.isArray(pack.indexes))throw Error('旧交火存档损坏');return structuredClone(pack);},
    exportArchive:async()=>empty(),importArchive:async pack=>api.validateArchive(pack),destroy(){if(window.XZ_CROSSFIRE===api)delete window.XZ_CROSSFIRE;}};
  window.XZ_CROSSFIRE=api;return api;
}
