#!/usr/bin/env node
/**
 * codex-crash-recovery-drill.mjs — a MANUAL end-to-end drill against the REAL Codex App Server.
 *
 *   node scripts/codex-crash-recovery-drill.mjs thread   # crash after the thread was accepted, before it was recorded
 *   node scripts/codex-crash-recovery-drill.mjs turn     # crash after the turn was accepted, before it was recorded
 *
 * It starts a PRIVATE app-server on a temporary unix socket, runs one real (tiny) turn through the
 * real client + runtime adapter while dropping the durable write that the "crash" would have lost,
 * restarts the adapter on the same database, and then asks the server how many threads/turns exist
 * for the message. Expected: threads=1 turns=1, one reply, one thread/start and one turn/start call.
 * Costs one tiny model turn; touches nothing of any real project. Override the binary with CODEX_BIN.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAppServerClient, createCodexAppServerInjector } from "./codex-app-server-wake.mjs";
import { CODEX_APP_SERVER_MEMBER_SLOT, CodexAppServerRuntimeAdapter, identityDigest } from "./agent-runtime-adapter.mjs";
import { RuntimeBindingStore } from "./runtime-binding-store.mjs";
import { WakeDispatchStore } from "./wake-dispatch-store.mjs";
const C=process.env.CODEX_BIN||"/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const mode=process.argv[2]; // "thread" | "turn"
const dir=mkdtempSync("/tmp/mur-lc-"); const cwd=path.join(dir,"cwd"); mkdirSync(cwd);
const sock=path.join(dir,"s.sock");
const srv=spawn(C,["app-server","--listen",`unix://${sock}`],{stdio:"ignore",cwd}); await new Promise(r=>setTimeout(r,2500));
const dbPath=path.join(dir,"murmur.db");
const stats={threadStarts:0,turnStarts:0};
class Probe extends CodexAppServerClient {
  async request(method,params){ if(method==="thread/start") stats.threadStarts++; const r=await super.request(method,params); if(method==="thread/start"&&mode==="thread"&&Probe.crash){ Probe.crash=false; throw new Error("PROCESS-DIED-after-thread-accepted"); } return r; }
  async startTurnAndWaitForFinal(params,options){ if(!options.attach) stats.turnStarts++;
    if(mode==="turn"&&Probe.crash&&!options.attach){ Probe.crash=false; return super.startTurnAndWaitForFinal(params,{...options,onTurnId:({abort})=>abort("simulated-crash")}); }
    return super.startTurnAndWaitForFinal(params,options); } }
Probe.crash=true;
const mk=(gen)=>{ const d=new WakeDispatchStore(dbPath,{recipientId:"codex-agent",maxAttempts:5}); const b=new RuntimeBindingStore(dbPath); const replies=[];
  const a=new CodexAppServerRuntimeAdapter({bindingStore:b,dispatchStore:d,agentId:"codex-agent",projectId:"p",peer:{socketPath:sock,cwd,reconcilePollMs:200,reconcileQuiescenceMs:1000},retryDelayMs:0,
    injector:createCodexAppServerInjector({Client:Probe,timeoutMs:3000,log:(l,m,x)=>console.log("   ·",m)}),sendReply:async(r)=>{replies.push(r);return{msgId:r.msgId}}});
  a.start({bindingId:`b${gen}`,runtimeGeneration:gen,leaseTtlMs:30000}); return {a,d,b,replies}; };
const MSG="live-crash-msg-0001";
const DIGEST=identityDigest({msgId:MSG,recipientId:"codex-agent",memberSlot:CODEX_APP_SERVER_MEMBER_SLOT});
const SRC=`murmur:v1:${DIGEST}`, CID=`murmur-turn:v1:${DIGEST}`;
let one=mk(1);
if(mode==="thread") one.a.turnStore.recordSeeded=()=>{}; else one.a.turnStore.recordLaunched=()=>{};
one.d.enqueue({msgId:MSG,from:"claude-agent",conversationId:"c",text:"Reply with exactly: OK",memberSlot:CODEX_APP_SERVER_MEMBER_SLOT});
const r1=await one.a.executeTurn(...(()=>{const d=one.d.claimDue(Date.now()+1000);return [d.payload,d]})());
console.log("attempt 1 (process 'dies'):",r1.status, r1.error?.message?.slice(0,70));
await one.a.shutdown(); one.b.close(); one.d.close();
await new Promise(r=>setTimeout(r,1500));
const two=mk(2);
const d2=two.d.claimDue(Date.now()+60000); const r2=await two.a.executeTurn(d2.payload,d2);
console.log("attempt 2 (restarted daemon):",r2.status,"replies:",two.replies.length, JSON.stringify(two.replies[0]?.text));
// count what really exists on the server for this message
const c=new CodexAppServerClient({socketPath:sock,timeoutMs:15000});
const loaded=(await c.request("thread/loaded/list",{})).data||[];
let threads=0,turns=0;
for(const id of loaded){ const r=await c.request("thread/read",{threadId:id,includeTurns:false}); if(r.thread.threadSource===SRC){ threads++; const t=await c.request("thread/turns/list",{threadId:id,itemsView:"full"}); turns+=(t.data||[]).filter(x=>(x.items||[]).some(i=>i.type==="userMessage"&&i.clientId===CID)).length; await c.request("thread/archive",{threadId:id}).catch(()=>{}); } }
console.log(`SERVER STATE for the msgId: threads=${threads} turns=${turns}   (client calls: thread/start=${stats.threadStarts} turn/start=${stats.turnStarts})`);
srv.kill(); rmSync(dir,{recursive:true,force:true}); process.exit(0);
