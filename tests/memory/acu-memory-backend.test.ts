import {beforeEach,describe,it,expect,vi} from 'vitest';
import {data,scope} from './fixture';
const mocks=vi.hoisted(()=>({current:null as any, chat:[{mes:'story',swipe_id:0,is_user:false}],busy:false,batch:vi.fn(),execute:vi.fn()}));
vi.mock('../../src/service/runtime/state-manager',()=>({get currentJsonTableData_ACU(){return mocks.current;},get isAutoUpdatingCard_ACU(){return mocks.busy;},isProcessing_Plot_ACU:false,_set_isAutoUpdatingCard_ACU:(v:boolean)=>mocks.busy=v,_set_wasStoppedByUser_ACU:vi.fn()}));
vi.mock('../../src/data/gateways/chat-gateway',()=>({getChatArray_ACU:()=>mocks.chat}));
vi.mock('../../src/service/table/update-orchestrator',()=>({processUpdatesBatch_ACU:mocks.batch,executeCardUpdateCore_ACU:mocks.execute}));
import {fillOriginalGuideNative_ACU} from '../../src/service/table/original-guide-fill-adapter';
import {sourceFloorIdentity_ACU} from '../../src/service/table/original-guide-fill-strategy';
import {stateFromData} from '../../src/memory/memory-mapper';
beforeEach(()=>{mocks.current=data();mocks.busy=false;mocks.execute.mockReset().mockResolvedValue({success:true,modifiedKeys:['sheet_memory']});mocks.batch.mockReset().mockImplementation(async(indices,mode,options,execute)=>{await execute(mocks.chat,0,mode,false,options.targetSheetKeys,options.requestOptions,{currentBatch:1,totalBatches:1},options.abortController);return {success:true};});});
function request(){return {requestId:'r',sourceFloors:[sourceFloorIdentity_ACU(mocks.chat[0],0)],targetSheetKey:scope.sheetKey,operation:'explicit_refill' as const,expectedRevision:stateFromData(mocks.current,scope).revision};}
describe('native fill adapter delegation',()=>{
  it('uses native batch/core with scoped sheets and no card prompt protocol',async()=>{await fillOriginalGuideNative_ACU(scope,request(),()=>{});expect(mocks.batch).toHaveBeenCalledTimes(1);const options=mocks.batch.mock.calls[0][2];expect(options).toMatchObject({targetSheetKeys:['sheet_memory'],planManaged:true,requestOptions:{originalGuideStrategy:{operation:'append'}}});expect(mocks.execute).toHaveBeenCalledTimes(1);expect(mocks.busy).toBe(false);});
  it('rejects wrong sheet, stale active swipe, revision and busy before model',async()=>{for(const patch of [{targetSheetKey:'sheet_other'},{expectedRevision:'stale'},{sourceFloors:[{...request().sourceFloors[0],swipeId:1}]}])await expect(fillOriginalGuideNative_ACU(scope,{...request(),...patch},()=>{})).rejects.toThrow();mocks.busy=true;await expect(fillOriginalGuideNative_ACU(scope,request(),()=>{})).rejects.toThrow(/正在运行/);expect(mocks.execute).not.toHaveBeenCalled();});
  it('coalesces duplicate triggers and releases the native busy flag on cancellation',async()=>{let finish!:()=>void;mocks.batch.mockImplementation(()=>new Promise(resolve=>finish=()=>resolve({success:true})));const req=request(),first=fillOriginalGuideNative_ACU(scope,req,()=>{}),second=fillOriginalGuideNative_ACU(scope,req,()=>{});expect(mocks.batch).toHaveBeenCalledTimes(1);finish();await Promise.all([first,second]);expect(mocks.busy).toBe(false);});
});
