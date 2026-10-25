import { useEffect, useRef, useState } from "react";
import { formatEther, parseEther } from "ethers";
import { IntentAgent, SERVICES } from "../../src/intent-agent";
import { attacks, runAttack, recovery, recoveryAction } from "./simulation";
import { AttacksView, AnomalyView, RecoveryView, FuzzerView, ContractsView } from "./FeatureViews";
import type { AttackResult, AttackId } from "../../src/attack-suite";
import type { BenchmarkMetrics } from "../../src/anomaly-guard";
import Copilot from "./Copilot";

const tabs = [["overview","Overview"],["copilot","Agent tasks"],["policy","Spending rules"],["attacks","Security lab"],["anomaly","Anomaly shield"],["recovery","Recovery"],["fuzzer","Verification"],["contracts","Contracts"]] as const;
type Tab = typeof tabs[number][0];
type Contract = {name:string; source:string; abi:unknown[]; bytecodeLength:number};
const emptyFuzz = {totalMutationsEvaluated:0, violationsDetected:0, invariantsVerified:{perTxBound:0,dailyCapBound:0,expiryBound:0,vetoIntegrity:0},runsPerSecond:0,elapsedMs:0};

export default function App() {
  const [tab,setTab] = useState<Tab>("overview");
  const [agent] = useState(() => new IntentAgent());
  const [tasks,setTasks] = useState(agent.list());
  const [aiAvailable,setAiAvailable] = useState(false);
  const [useAi,setUseAi] = useState(false);
  const [planning,setPlanning] = useState(false);
  const [aiMessage,setAiMessage] = useState("");
  const [request,setRequest] = useState("");
  const [notice,setNotice] = useState("Ready. Choose an action to begin.");
  const [paused,setPaused] = useState(false);
  const [result,setResult] = useState<AttackResult|null>(null);
  const [results,setResults] = useState<Record<string,boolean>>({});
  const [metrics,setMetrics] = useState<BenchmarkMetrics|null>(null);
  const [threshold,setThreshold] = useState(75);
  const [recoveryState,setRecovery] = useState(recovery.getState());
  const [contracts,setContracts] = useState<Contract[]>([]);
  const [contractError,setContractError] = useState("");
  const [fuzz,setFuzz] = useState(emptyFuzz);
  const [fuzzRunning,setFuzzRunning] = useState(false);
  const fuzzWorker = useRef<Worker|null>(null);
  const [anomalyBusy,setAnomalyBusy] = useState(false);
  const [limits,setLimits] = useState({perTx:"0.05",daily:"0.25"});
  const [enabled,setEnabled] = useState(SERVICES.map(() => true));
  const remaining = agent.dailyLimit > agent.spent ? agent.dailyLimit-agent.spent : 0n;
  const showError = (error:unknown) => setNotice(error instanceof Error ? error.message : String(error));
  const loadContracts = async () => {
    try {
      setContractError("");
      const response = await fetch("/contracts.json");
      if (!response.ok || !response.headers.get("content-type")?.includes("json")) throw new Error("Contract sources could not load. Build the project, then retry.");
      setContracts((await response.json()).contracts);
    } catch(error) { setContractError(String(error)); }
  };
  useEffect(() => { void loadContracts(); void fetch("/api/intent").then(r=>r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : {available:false}).then(data=>setAiAvailable(data.available===true)).catch(()=>setAiAvailable(false)); return () => fuzzWorker.current?.terminate(); },[]);
  useEffect(() => {
    setAnomalyBusy(true);
    const worker = new Worker(new URL("./benchmark-worker.ts",import.meta.url),{type:"module"});
    worker.onmessage = ({data}) => { if(data.error) setNotice(data.error); else setMetrics(data.metrics); setAnomalyBusy(false); worker.terminate(); };
    worker.onerror = () => {setNotice("Anomaly checks failed. Change the threshold to retry.");setAnomalyBusy(false);worker.terminate();};
    worker.postMessage({threshold});
    return () => worker.terminate();
  },[threshold]);
  const evaluateAttack = async (id:AttackId) => {
    try {
      setNotice("Running security scenario…");
      await new Promise(resolve => setTimeout(resolve,0));
      const next=runAttack(id);setResult(next);setResults(previous => ({...previous,[id]:next.passed}));
      setNotice(next.passed ? "Scenario passed in the wallet model." : "Scenario failed. Review the trace.");
    } catch(error) {showError(error);throw error;}
  };
  const startFuzz = (flawed:boolean,iterations:number) => {
    fuzzWorker.current?.terminate();setFuzz(emptyFuzz);setFuzzRunning(true);
    try {
      const worker=new Worker("/fuzz-worker.js", { type: "module" });fuzzWorker.current=worker;
      worker.onmessage=({data}) => {setFuzz(data);if(data.type==="complete"){worker.terminate();setFuzzRunning(false);setNotice(data.violationsDetected ? "A violation was found. Review the result." : "Checks finished. No violations found in this run.");}};
      worker.onerror=(event) => {worker.terminate();setFuzzRunning(false);setNotice("Verification could not run: "+(event.message || "worker unavailable")+". Retry the checks.");};
      worker.postMessage({iterations:Math.min(50000,Math.max(5000,Math.floor(iterations)||5000)),flawedContract:flawed,seed:0xa9e17});
    } catch(error){setFuzzRunning(false);showError(error);}
  };
  const submit=async(text:string) => {
    if(!text.trim() || planning)return;
    if(!useAi){agent.plan(text.trim());setTasks(agent.list());setRequest("");setTab("copilot");return;}
    setPlanning(true);setAiMessage("");
    try {
      const response=await fetch("/api/intent",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({request:text}),signal:AbortSignal.timeout(20000)});
      if(!response.headers.get("content-type")?.includes("json"))throw new Error("AI endpoint is unavailable. Use the local planner.");
      const data=await response.json();
      if(!response.ok)throw new Error(data.error || "AI request failed.");
      setAiMessage(data.message);
      if(data.action==="payment"){
        if(typeof data.amount!=="string" || !/^\d+(\.\d{1,18})?$/.test(data.amount) || typeof data.recipient!=="string" || !/^0x[0-9a-fA-F]{40}$/.test(data.recipient))throw new Error("AI returned an invalid proposal.");
        agent.plan("Pay "+data.amount+" ETH to "+data.recipient,text);
        setTasks(agent.list());setRequest("");setTab("copilot");
      }
    }catch(error){showError(error);}finally{setPlanning(false);}
  };
  const applyRules=() => {
    try {
      const per=parseEther(limits.perTx),daily=parseEther(limits.daily);
      if(per<=0n || daily<=0n || per>daily)throw new Error("Use positive limits, with the payment limit no greater than the daily limit.");
      agent.perTransaction=per;agent.dailyLimit=daily;agent.allowedTargets=new Set(SERVICES.filter((_,i)=>enabled[i]).map(s=>s.address));
      setTasks(agent.list());setNotice("Demo rules saved. Pending tasks will be checked again when confirmed.");
    }catch(error){showError(error);}
  };
  return <div className="app-shell">
    <header className="app-header"><a href="#" onClick={e=>{e.preventDefault();setTab("overview");}} className="brand">nexus<span>Wallet workspace</span></a><div className="header-actions"><span className="demo-label">Demo workspace</span><button onClick={()=>{agent.paused=!paused;setPaused(!paused);setNotice(!paused?"Agent paused. Payment confirmations are blocked.":"Agent resumed.");}}>{paused?"Resume agent":"Pause agent"}</button></div></header>
    <nav aria-label="Main navigation">{tabs.map(([id,label])=><button key={id} aria-current={tab===id?"page":undefined} onClick={()=>setTab(id)}>{label}</button>)}</nav>
    <main className="workspace">
      <div className="demo-note">Practice with example funds. Nothing here sends real money. State resets when you reload this page.</div>
      <div className="status-message" role="status">{notice}</div>
      {paused&&<div className="warning">Agent paused. Resume it before confirming a payment simulation.</div>}
      {tab==="overview"&&<>
        <div className="page-heading"><p className="eyebrow">YOUR WORKSPACE</p><h1>A clear view of your wallet.</h1><p>Review your allowance, plan a payment, or check how the safety rules work.</p></div>
        <section className="summary-grid">
          <article className="panel"><p>Example balance</p><strong>20 ETH</strong><small>Illustrative balance, not a connected wallet</small></article>
          <article className="panel"><p>Available daily allowance</p><strong>{formatEther(remaining)} ETH</strong><small>{formatEther(agent.spent)} of {formatEther(agent.dailyLimit)} ETH used in this demo</small></article>
          <article className="panel"><p>Agent tasks</p><strong>{tasks.filter(t=>t.status==="awaiting_confirmation").length} to review</strong><small>{tasks.filter(t=>t.status==="completed").length} simulations completed</small></article>
        </section>
        <section className="panel next-action"><div><h2>What would you like to do?</h2><p>Start with a payment request. You’ll see the plan before anything runs.</p></div><button className="primary" onClick={()=>setTab("copilot")}>Plan a payment →</button></section>
        <section className="quick-grid">
          <button className="panel quick-link" onClick={()=>setTab("policy")}><h2>Set spending rules</h2><p>Choose payment limits and approved services.</p></button>
          <button className="panel quick-link" onClick={()=>setTab("attacks")}><h2>Test the safeguards</h2><p>Explore six attack scenarios and inspect the results.</p></button>
          <button className="panel quick-link" onClick={()=>setTab("recovery")}><h2>Practice account recovery</h2><p>Try guardian approvals, the waiting period, and cancellation.</p></button>
        </section>
        <section className="panel"><h2>Recent tasks</h2>{tasks.length?tasks.slice(0,4).map(t=><div className="activity-row" key={t.id}><span>{t.request}</span><span>{t.status.replaceAll("_"," ")}</span></div>):<p>No tasks yet. Your plans and results will appear here.</p>}</section>
      </>}
      {tab==="copilot"&&<>
        <div className="page-heading"><p className="eyebrow">INTENT-DRIVEN AGENT</p><h1>Tell us the outcome.</h1><p>The agent creates a payment plan, checks your rules, and waits for your confirmation.</p></div>
        <section className="panel"><p className="muted">{aiAvailable ? "AI interpretation is available. It proposes plans; it cannot execute payments." : "Local deterministic planner · ETH payment simulations only · AI service not configured"}</p>
          {aiAvailable && <label className="service-option"><input type="checkbox" checked={useAi} onChange={e=>setUseAi(e.target.checked)}/> Use AI interpretation (sends this request to OpenAI; never include wallet secrets)</label>}{aiMessage && <p role="status">{aiMessage}</p>}
          <form onSubmit={e=>{e.preventDefault();submit(request);}}><label htmlFor="intent">What should the agent do?</label><div className="input-row"><input id="intent" value={request} onChange={e=>setRequest(e.target.value)} placeholder="Pay 0.005 ETH to Inference API" maxLength={2000} required/><button className="primary" disabled={planning}>{planning?"Planning…":"Create plan"}</button></div></form>
          <div className="suggestions"><button onClick={()=>submit("Pay 0.005 ETH to Inference API")}>Pay for inference</button><button onClick={()=>submit("Send 0.04 ETH to Cloud GPU")}>Try a payment above today's allowance</button><button onClick={()=>setTab("policy")}>Review my rules</button></div>
        </section>
        <section aria-label="Agent task history" className="task-list">{tasks.length===0&&<div className="empty-state">Your first plan will appear here. Nothing runs until you confirm.</div>}
          {tasks.map(task=><article className="panel task-card" key={task.id}><div className="task-heading"><h2>{task.request}</h2><span className={"task-status "+task.status}>{task.status.replaceAll("_"," ")}</span></div>
            {task.amount&&<p><b>Amount:</b> {task.amount} ETH</p>}{task.target&&<p className="address"><b>Recipient:</b> {task.target}</p>}<p>{task.reason}</p>
            {task.status==="awaiting_confirmation"&&<div className="suggestions"><button className="primary" disabled={paused} onClick={()=>{try{agent.confirm(task.id);setTasks(agent.list());setNotice("Task updated. Review its result below.");}catch(error){showError(error);}}}>Confirm simulation</button><button onClick={()=>{agent.cancel(task.id);setTasks(agent.list());}}>Cancel</button></div>}
            <details><summary>Plan and activity</summary><ol>{task.steps.map(s=><li key={s}>{s}</li>)}</ol><ul>{task.events.map((e,i)=><li key={i}>{e}</li>)}</ul></details>
          </article>)}
        </section>
      </>}
      {tab==="policy"&&<><div className="page-heading"><h1>Your spending rules</h1><p>These rules control payment simulations. Every payment still needs your confirmation.</p></div><section className="panel rules-form"><label>Maximum per payment (ETH)<input value={limits.perTx} onChange={e=>setLimits({...limits,perTx:e.target.value})} inputMode="decimal"/></label><label>Daily allowance (ETH)<input value={limits.daily} onChange={e=>setLimits({...limits,daily:e.target.value})} inputMode="decimal"/></label><h2>Approved services</h2>{SERVICES.map((service,i)=><label className="service-option" key={service.address}><input type="checkbox" checked={enabled[i]} onChange={e=>setEnabled(enabled.map((v,j)=>i===j?e.target.checked:v))}/><span>{service.name}<small className="address">{service.address}</small></span></label>)}<button className="primary" onClick={applyRules}>Save demo rules</button></section></>}
      {tab==="attacks"&&<><p className="section-help">{Object.keys(results).length} of 6 scenarios run · {Object.values(results).filter(Boolean).length} passed. Each scenario uses its own preset limits. Select one to see its trace.</p><AttacksView attacks={attacks} result={result} onRunAttack={evaluateAttack} setNotice={setNotice}/></>}
      {tab==="anomaly"&&<><p className="section-help">{anomalyBusy?"Calculating benchmark…":"Benchmark complete."} Results use 1,000 synthetic patterns, not live monitoring. Containment time starts at the first attack input.</p><AnomalyView anomaly={metrics} threshold={threshold} onThresholdChange={async value=>setThreshold(value)}/></>}
      {tab==="recovery"&&<><p className="section-help">Propose a replacement key → collect 3 approvals → advance the demo clock → finalize. Guardian buttons simulate signatures.</p><RecoveryView recovery={recoveryState} onAction={async(path,body,message)=>{try{setRecovery(recoveryAction(path,body));setNotice(message);}catch(error){showError(error);}}}/></>}
      {tab==="fuzzer"&&<>{fuzzRunning&&<div className="status-message" role="status">Checks running… <button onClick={()=>{fuzzWorker.current?.terminate();setFuzzRunning(false);setNotice("Checks stopped. Displayed results are partial.");}}>Stop checks</button></div>}<FuzzerView fuzz={fuzz} onStartFuzz={startFuzz}/></>}
      {tab==="contracts"&&<><p className="section-help">Source and ABI from this build. These are not verified deployment addresses.</p>{contractError?<div role="alert">{contractError} <button onClick={()=>void loadContracts()}>Retry</button></div>:contracts.length?<ContractsView contracts={contracts} setNotice={setNotice}/>:<p>Loading contract sources…</p>}</>}
    </main><footer className="app-footer">Nexus · A workspace for understanding agent payments</footer>
    <Copilot aiAvailable={aiAvailable} context={{
      page: tab, paused, spent: formatEther(agent.spent), dailyLimit: formatEther(agent.dailyLimit),
      perTransaction: formatEther(agent.perTransaction), allowedTargets: [...agent.allowedTargets],
      tasks: tasks.slice(0, 5).map(({ request, status, reason }) => ({ request, status, reason })),
    }} onNavigate={setTab} onPlan={(amount, recipient) => {
      agent.plan("Pay " + amount + " ETH to " + recipient);
      setTasks(agent.list()); setTab("copilot");
      setNotice("Copilot created a plan. Review its current checks before confirming.");
    }}/>
  </div>;
}
