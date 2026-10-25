import { useState } from "react";
import { ShieldCheck, Check, CheckCircle2 } from "lucide-react";
type AttackId = "direct-drain" | "micro-drain" | "selector-spoof" | "expired-replay" | "paymaster-siphon" | "recipient-diversion";
interface AttackEntry { id: AttackId; title: string; threat: string; defense: string; }
interface TraceStep { index: number; phase: string; status: string; label: string; details: Record<string, string>; }
interface AttackResult { id: AttackId; title: string; description: string; passed: boolean; lossWei: string; dailyLimitWei: string; gasLoss: string; steps: TraceStep[]; metrics: Record<string, string>; proof: { inequality: string; hash: string; }; }
interface AnomalyMetrics { threshold: number; totalPatterns: number; truePositiveDetectionRate: number; falseFreezeRate: number; meanTimeToContainmentSeconds: number; meanTimeToContainmentBlocks: number; roc: Array<{ threshold: number; truePositiveRate: number; falsePositiveRate: number }>; proofHash: string; }
interface Guardian { id: string; name: string; address: string; role?: string; }
interface RecoveryProposal { id: number; proposer: string; newKey: string; target: "owner" | "agent"; status: string; approvals: string[]; executableAfter: number; }
interface RecoveryState { owner: string; agentKey: string; guardians: Guardian[]; proposal: RecoveryProposal | null; now: number; audit: Array<{ timestamp: number; action: string; actor: string; hash: string; details: Record<string, string> }>; quorum: number; delaySeconds: number; }
interface FuzzState { totalMutationsEvaluated: number; violationsDetected: number; invariantsVerified: { perTxBound: number; dailyCapBound: number; expiryBound: number; vetoIntegrity: number }; runsPerSecond: number; elapsedMs: number; firstViolation?: unknown; proofHash?: string; }
interface ContractSource { name: string; source: string; abi: unknown[]; bytecodeLength: number; }

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function truncateAddress(addr: string, left = 6, right = 4): string { return addr.length <= left + right ? addr : addr.slice(0,left) + "..." + addr.slice(-right); }
export function AttacksView({
  attacks,
  result,
  onRunAttack,
  setNotice,
}: {
  attacks: AttackEntry[];
  result: AttackResult | null;
  onRunAttack: (id: AttackId) => Promise<void>;
  setNotice: (v: string) => void;
}) {
  const [runningAll, setRunningAll] = useState(false);

  const runAll = async () => {
    setRunningAll(true);
    try { for (const a of attacks) await onRunAttack(a.id); setNotice("All security scenarios evaluated"); } catch { setNotice("A scenario failed to run. Retry it individually."); } finally { setRunningAll(false); }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-[#e7e5e4] p-6 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[#1c1917]">Security simulation lab</h2>
          <p className="text-xs text-[#78716c] mt-0.5 max-w-xl">
            Run six scenarios against the wallet model. These tests do not execute deployed contracts.
          </p>
        </div>
        <button
          onClick={runAll}
          disabled={runningAll}
          className="px-4 py-2 bg-[#1c1917] hover:bg-[#292524] disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors shrink-0"
        >
          {runningAll ? "Running tests..." : "Run all 6 tests"}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {attacks.map((item) => {
          const isSelected = result?.id === item.id;
          return (
            <div
              key={item.id} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void onRunAttack(item.id).catch(() => {}); } }}
              onClick={() => void onRunAttack(item.id).catch(() => {})}
              className={`p-5 rounded-xl border cursor-pointer transition-all ${
                isSelected
                  ? "bg-white border-[#1c1917] shadow-sm"
                  : "bg-white border-[#e7e5e4] hover:border-[#d6d3d1]"
              }`}
            >
              <h3 className="text-sm font-semibold text-[#1c1917] mb-1.5">{item.title}</h3>
              <p className="text-xs text-[#78716c] leading-relaxed mb-4">{item.threat}</p>
              <div className="pt-3 border-t border-[#f5f5f4] flex items-center justify-between text-xs">
                <span className="text-[#15803d] font-medium flex items-center gap-1">
                  <ShieldCheck size={14} />
                  <span>Ready to test</span>
                </span>
                <span className="text-[#78716c]">Click to test</span>
              </div>
            </div>
          );
        })}
      </div>

      {result ? (
        <div className="bg-white rounded-xl border border-[#e7e5e4] p-6 shadow-xs space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 pb-3 border-b border-[#f5f5f4]">
            <div>
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-[#f0fdf4] text-[#15803d]">
                  {result.passed ? "Passed" : "Failed"}
                </span>
                <h3 className="text-sm font-semibold text-[#1c1917]">{result.title}</h3>
              </div>
              <p className="text-xs text-[#78716c] mt-1">{result.description}</p>
            </div>
            <div className="text-xs text-[#78716c]">
              Verification: <span className="mono font-semibold text-[#1c1917]">{result.proof.inequality}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-[#fafaf9] p-3.5 rounded-lg border border-[#e7e5e4] text-xs">
            <div>
              <span className="text-[#78716c]">Simulated wallet loss</span>
              <div className="mono font-semibold text-[#1c1917] text-sm mt-0.5">
                {(Number(result.lossWei) / 1e18).toFixed(4)} ETH
              </div>
            </div>
            <div>
              <span className="text-[#78716c]">Daily cap constraint</span>
              <div className="mono font-semibold text-[#1c1917] text-sm mt-0.5">
                {(Number(result.dailyLimitWei) / 1e18).toFixed(4)} ETH
              </div>
            </div>
            <div>
              <span className="text-[#78716c]">Gas spent</span>
              <div className="mono font-semibold text-[#1c1917] text-sm mt-0.5">{result.gasLoss}</div>
            </div>
            <div>
              <span className="text-[#78716c]">Verdict</span>
              <div className="font-semibold text-[#15803d] text-sm mt-0.5">{result.passed ? "Passed" : "Failed"}</div>
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-[#1c1917] mb-2">Execution lifecycle trace</div>
            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              {result.steps.map((st, rowIndex) => (
                <div key={result.id + "-" + rowIndex} className="p-2 bg-[#fafaf9] border border-[#e7e5e4] rounded text-xs flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="mono text-[#a8a29e]">#{st.index}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                      st.status === "reverted"
                        ? "bg-[#fef2f2] text-[#dc2626]"
                        : "bg-[#f0fdf4] text-[#15803d]"
                    }`}>
                      {st.status}
                    </span>
                    <span className="text-[#44403c] font-medium">{st.label}</span>
                  </div>
                  <span className="mono text-[11px] text-[#78716c] hidden sm:inline">
                    {Object.entries(st.details).slice(0, 2).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="p-8 text-center bg-white rounded-xl border border-[#e7e5e4] text-[#78716c] text-xs">
          Select any attack scenario above to run the live simulation.
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// View 4: Anomaly Shield
// ═══════════════════════════════════════════════════════

export function AnomalyView({
  anomaly,
  threshold,
  onThresholdChange,
}: {
  anomaly: AnomalyMetrics | null;
  threshold: number;
  onThresholdChange: (v: number) => Promise<void>;
}) {
  const tpr = anomaly ? (anomaly.truePositiveDetectionRate * 100).toFixed(1) : "—";
  const fpr = anomaly ? (anomaly.falseFreezeRate * 100).toFixed(1) : "—";
  const mttc = anomaly ? anomaly.meanTimeToContainmentBlocks : "—";

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white p-5 rounded-xl border border-[#e7e5e4] shadow-xs">
          <span className="text-xs text-[#78716c]">Detection rate</span>
          <div className="text-2xl font-semibold text-[#1c1917] mono mt-1">{tpr}%</div>
          <p className="text-xs text-[#a8a29e] mt-1">Successfully catches anomalous bursts</p>
        </div>
        <div className="bg-white p-5 rounded-xl border border-[#e7e5e4] shadow-xs">
          <span className="text-xs text-[#78716c]">False interruption rate</span>
          <div className="text-2xl font-semibold text-[#1c1917] mono mt-1">{fpr}%</div>
          <p className="text-xs text-[#a8a29e] mt-1">Legitimate payments interrupted</p>
        </div>
        <div className="bg-white p-5 rounded-xl border border-[#e7e5e4] shadow-xs">
          <span className="text-xs text-[#78716c]">Containment time</span>
          <div className="text-2xl font-semibold text-[#1c1917] mono mt-1">{mttc} blocks</div>
          <p className="text-xs text-[#a8a29e] mt-1">{anomaly ? anomaly.meanTimeToContainmentSeconds.toFixed(2) + " seconds in the synthetic benchmark" : "Waiting for benchmark"}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-[#e7e5e4] p-6 shadow-xs space-y-4">
          <div>
            <h2 className="text-base font-semibold text-[#1c1917]">Circuit breaker sensitivity</h2>
            <p className="text-xs text-[#78716c] mt-0.5">
              Adjust the score that triggers a pause in the synthetic benchmark.
            </p>
          </div>

          <div className="pt-2">
            <div className="flex justify-between items-center text-xs font-medium mb-1.5">
              <span className="text-[#44403c]">Risk score trigger threshold</span>
              <span className="mono font-semibold text-[#1c1917]">{threshold} / 100</span>
            </div>
            <input
              aria-label="Risk score trigger threshold"
              type="range"
              min="20"
              max="95"
              value={threshold}
              onChange={(e) => void onThresholdChange(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-[11px] text-[#a8a29e] mt-1">
              <span>Strict (Pauses sooner)</span>
              <span>Demo default: 75</span>
              <span>Lenient</span>
            </div>
          </div>

          <div className="space-y-2 pt-4 border-t border-[#f5f5f4] text-xs text-[#44403c]">
            <div className="font-semibold text-[#1c1917] mb-1">What the anomaly engine tracks:</div>
            <div className="flex justify-between p-2 bg-[#fafaf9] rounded border border-[#e7e5e4]">
              <span>Transaction rate spike</span>
              <span className="text-[#78716c]">4× normal baseline</span>
            </div>
            <div className="flex justify-between p-2 bg-[#fafaf9] rounded border border-[#e7e5e4]">
              <span>Payment size volatility</span>
              <span className="text-[#78716c]">3σ standard deviation</span>
            </div>
            <div className="flex justify-between p-2 bg-[#fafaf9] rounded border border-[#e7e5e4]">
              <span>Unfamiliar recipient</span>
              <span className="text-[#78716c]">New address within 60 minutes</span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-[#e7e5e4] p-6 shadow-xs space-y-3">
          <div>
            <h2 className="text-base font-semibold text-[#1c1917]">Detection quality curve</h2>
            <p className="text-xs text-[#78716c] mt-0.5">Evaluated across 1,000 synthetic transaction patterns</p>
          </div>

          <div className="bg-[#fafaf9] border border-[#e7e5e4] rounded-lg p-3">
            <svg viewBox="0 0 100 60" className="w-full h-40">
              <line x1="10" y1="5" x2="95" y2="5" stroke="#f5f5f4" strokeWidth="0.5" />
              <line x1="10" y1="27.5" x2="95" y2="27.5" stroke="#f5f5f4" strokeWidth="0.5" />
              <line x1="10" y1="50" x2="95" y2="50" stroke="#e7e5e4" strokeWidth="0.8" />
              <line x1="10" y1="5" x2="10" y2="50" stroke="#e7e5e4" strokeWidth="0.8" />
              <line x1="10" y1="50" x2="95" y2="5" stroke="#e7e5e4" strokeDasharray="1.5,1.5" strokeWidth="0.6" />
              <polyline points={anomaly?.roc.map(point => (10 + point.falsePositiveRate * 85) + "," + (50 - point.truePositiveRate * 45)).join(" ") ?? ""} fill="none" stroke="#1c1917" strokeWidth="1.8" />
              {anomaly && <circle cx={10 + anomaly.falseFreezeRate * 85} cy={50 - anomaly.truePositiveDetectionRate * 45} r="2.5" fill="#1c1917" />}
              <text x="10" y="56" fill="#a8a29e" fontSize="2.8">0.0 False positive rate</text>
              <text x="70" y="56" fill="#a8a29e" fontSize="2.8">1.0</text>
              <text x="1" y="8" fill="#a8a29e" fontSize="2.8">1.0 True positive rate</text>
            </svg>
          </div>
          <p className="text-xs text-[#78716c] leading-relaxed">
            The curve compares measured detection and false interruptions across thresholds. The dot shows the current result.
          </p>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// View 5: Guardian Recovery
// ═══════════════════════════════════════════════════════

export function RecoveryView({
  recovery,
  onAction,
}: {
  recovery: RecoveryState;
  onAction: (path: string, body: Record<string, unknown>, message: string) => Promise<void>;
}) {
  const [newKey, setNewKey] = useState("0xa300000000000000000000000000000000000003");
  const [target, setTarget] = useState<"agent" | "owner">("agent");
  const [proposer, setProposer] = useState(recovery.guardians[0]?.address || "");
  const proposal = recovery.proposal;
  const approvals = new Set(proposal?.approvals || []);

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-[#e7e5e4] p-6 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 pb-3 border-b border-[#f5f5f4]">
          <div>
            <h2 className="text-base font-semibold text-[#1c1917]">3-of-5 guardian social recovery</h2>
            <p className="text-xs text-[#78716c] mt-0.5">
              Requires 3 guardian signatures plus a mandatory 48-hour timelock with owner veto.
            </p>
          </div>
          <span className="text-xs text-[#78716c]">
            {proposal ? `Proposal #${proposal.id} (${proposal.status})` : "No active proposal"}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 pt-2">
          {recovery.guardians.map((g) => {
            const hasSigned = approvals.has(g.address.toLowerCase());
            const canSign = !!proposal && proposal.status === "active" && !hasSigned;
            return (
              <div key={g.id} className="p-3.5 rounded-lg border border-[#e7e5e4] bg-[#fafaf9] flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-xs text-[#1c1917]">{g.name}</span>
                    {hasSigned && <Check size={14} className="text-[#15803d]" />}
                  </div>
                  <div className="text-[11px] text-[#78716c] mb-2">{g.role}</div>
                  <div className="mono text-[10px] text-[#a8a29e]">{truncateAddress(g.address, 6, 4)}</div>
                </div>

                <button
                  disabled={!canSign}
                  onClick={() => void onAction("/api/recovery/approve", { guardian: g.address }, `${g.name} signature recorded`)}
                  className={`mt-3 w-full py-1.5 rounded text-xs font-medium transition-colors ${
                    hasSigned
                      ? "bg-[#f0fdf4] text-[#15803d] border border-[#bbf7d0] cursor-default"
                      : canSign
                      ? "bg-[#1c1917] hover:bg-[#292524] text-white"
                      : "bg-[#f5f5f4] text-[#a8a29e] cursor-not-allowed"
                  }`}
                >
                  {hasSigned ? "Signed" : canSign ? "Sign approval" : "Standby"}
                </button>
              </div>
            );
          })}
        </div>

        <div className="p-4 bg-[#fafaf9] rounded-lg border border-[#e7e5e4] space-y-3 mt-4">
          <span className="text-xs font-semibold text-[#1c1917] block">Propose key rotation</span>
          <div className="flex flex-col sm:flex-row gap-2">
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value as "agent" | "owner")}
              className="px-3 py-1.5 text-xs border border-[#e7e5e4] rounded-lg bg-white"
            >
              <option value="agent">Rotate compromised agent key</option>
              <option value="owner">Recover owner key</option>
            </select>
            <select
              value={proposer}
              onChange={(e) => setProposer(e.target.value)}
              className="px-3 py-1.5 text-xs border border-[#e7e5e4] rounded-lg bg-white"
            >
              {recovery.guardians.map((g) => (
                <option key={g.id} value={g.address}>Initiator: {g.name}</option>
              ))}
            </select>
            <input
              type="text"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="0x replacement key address"
              className="flex-1 px-3 py-1.5 text-xs border border-[#e7e5e4] rounded-lg mono bg-white"
            />
            <button
              onClick={() => void onAction("/api/recovery/initiate", { guardian: proposer, newKey, target }, "Recovery proposal initiated")}
              className="px-3.5 py-1.5 bg-[#1c1917] hover:bg-[#292524] text-white rounded-lg text-xs font-medium"
            >
              Propose rotation
            </button>
          </div>
        </div>
      </div>

      {proposal && (
        <div className="bg-white rounded-xl border border-[#e7e5e4] p-5 shadow-xs space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2 pb-3 border-b border-[#f5f5f4]">
            <div>
              <h3 className="text-sm font-semibold text-[#1c1917]">Active recovery: Rotate {proposal.target}</h3>
              <p className="text-xs text-[#78716c]">Replacement key: <span className="mono">{proposal.newKey}</span></p>
            </div>
            <div className="text-xs text-[#78716c]">
              Quorum: <span className="mono font-semibold text-[#1c1917]">{proposal.approvals.length} of 3 signatures</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              disabled={proposal.status !== "pending"}
              onClick={() => void onAction("/api/recovery/fast-forward", { seconds: String(recovery.delaySeconds) }, "Fast-forwarded 48-hour timelock (simulation)")}
              className="px-3 py-1.5 bg-[#f5f5f4] hover:bg-[#e7e5e4] disabled:opacity-40 text-[#44403c] rounded-md text-xs font-medium"
            >
              Fast-forward 48h (simulation)
            </button>
            <button
              disabled={proposal.status !== "pending" || recovery.now < proposal.executableAfter}
              onClick={() => void onAction("/api/recovery/execute", { guardian: proposer }, "New key installed successfully")}
              className="px-3 py-1.5 bg-[#15803d] hover:bg-[#166534] disabled:opacity-40 text-white rounded-md text-xs font-medium"
            >
              Finalize key rotation
            </button>
            <button
              disabled={proposal.status !== "active" && proposal.status !== "pending"}
 onClick={() => void onAction("/api/recovery/veto", { owner: recovery.owner }, "Owner veto exercised — proposal cancelled")}
              className="ml-auto px-3.5 py-1.5 bg-[#dc2626] hover:bg-[#b91c1c] text-white rounded-md text-xs font-medium"
            >
              Cancel recovery (Owner veto)
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-[#e7e5e4] p-5 shadow-xs">
        <h3 className="text-xs font-semibold text-[#1c1917] mb-2">Audit history</h3>
        <div className="divide-y divide-[#f5f5f4] text-xs">
          {recovery.audit.slice().reverse().map((ev, i) => (
            <div key={i} className="py-2.5 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="mono text-[#a8a29e]">{new Date(ev.timestamp * 1000).toLocaleTimeString()}</span>
                <span className="font-medium text-[#1c1917]">{ev.action}</span>
                <span className="text-[#78716c]">by {truncateAddress(ev.actor, 8, 6)}</span>
              </div>
              <span className="mono text-[11px] text-[#a8a29e] hidden sm:inline">{truncateAddress(ev.hash, 8, 6)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// View 6: Formal Verification (Fuzzer)
// ═══════════════════════════════════════════════════════

export function FuzzerView({
  fuzz,
  onStartFuzz,
}: {
  fuzz: FuzzState;
  onStartFuzz: (flawed: boolean, iterations: number) => void;
}) {
  const [iterations, setIterations] = useState(5000);
  const [flawed, setFlawed] = useState(false);

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-[#e7e5e4] p-6 shadow-xs space-y-4">
        <div>
          <h2 className="text-base font-semibold text-[#1c1917]">Randomized safety checks</h2>
          <p className="text-xs text-[#78716c] mt-0.5 max-w-xl">
            Try randomized inputs against the wallet model to look for policy violations. Passing a run is not a formal proof or smart-contract audit.
          </p>
        </div>

        <div className="p-4 bg-[#fafaf9] border border-[#e7e5e4] rounded-lg flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div>
              <span className="text-xs text-[#78716c] block mb-1">Mutation count</span>
              <input
                type="number"
                min={5000}
                max={50000}
                step={5000}
                value={iterations}
                onChange={(e) => setIterations(Math.min(50000, Math.max(5000, Number(e.target.value) || 5000)))}
                className="w-28 px-3 py-1.5 border border-[#e7e5e4] rounded-lg text-xs mono bg-white"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-[#44403c] cursor-pointer pt-4">
              <input
                type="checkbox"
                checked={flawed}
                onChange={(e) => setFlawed(e.target.checked)}
                className="rounded"
              />
              <span>Simulate flawed implementation</span>
            </label>
          </div>

          <button
            onClick={() => onStartFuzz(flawed, iterations)}
            className="px-4 py-2 bg-[#1c1917] hover:bg-[#292524] text-white rounded-lg text-xs font-medium"
          >
            Run {iterations.toLocaleString()} mutations
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
          <div className="p-3.5 bg-[#fafaf9] rounded-lg border border-[#e7e5e4]">
            <span className="text-xs text-[#78716c]">Mutations evaluated</span>
            <div className="mono font-semibold text-[#1c1917] text-base mt-0.5">{fuzz.totalMutationsEvaluated.toLocaleString()}</div>
          </div>
          <div className="p-3.5 bg-[#fafaf9] rounded-lg border border-[#e7e5e4]">
            <span className="text-xs text-[#78716c]">Violations found</span>
            <div className={`mono font-semibold text-base mt-0.5 ${fuzz.violationsDetected === 0 ? "text-[#15803d]" : "text-[#dc2626]"}`}>
              {fuzz.violationsDetected}
            </div>
          </div>
          <div className="p-3.5 bg-[#fafaf9] rounded-lg border border-[#e7e5e4]">
            <span className="text-xs text-[#78716c]">Speed</span>
            <div className="mono font-semibold text-[#1c1917] text-base mt-0.5">{fuzz.runsPerSecond.toLocaleString()} /s</div>
          </div>
          <div className="p-3.5 bg-[#fafaf9] rounded-lg border border-[#e7e5e4]">
            <span className="text-xs text-[#78716c]">Elapsed time</span>
            <div className="mono font-semibold text-[#1c1917] text-base mt-0.5">{fuzz.elapsedMs.toFixed(1)} ms</div>
          </div>
        </div>

        <div className={`p-3.5 rounded-lg border text-xs ${
          fuzz.violationsDetected === 0
            ? "bg-[#f0fdf4] border-[#bbf7d0] text-[#15803d]"
            : "bg-[#fef2f2] border-[#fecaca] text-[#991b1b]"
        }`}>
          {fuzz.violationsDetected === 0 ? (
            <div className="flex items-center gap-2 font-medium">
              <CheckCircle2 size={16} />
              <span>{fuzz.totalMutationsEvaluated === 0 ? "No checks run yet." : "No violations found in the evaluated inputs."}</span>
            </div>
          ) : (
            <div>
              <div className="font-semibold mb-1">Violation detected in flawed simulation:</div>
              <pre className="mono text-[11px] p-2 bg-white rounded border border-[#fecaca] overflow-x-auto">
                {JSON.stringify(fuzz.firstViolation, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// View 7: Smart Contracts & Code
// ═══════════════════════════════════════════════════════

export function ContractsView({
  contracts,
  setNotice,
}: {
  contracts: ContractSource[];
  setNotice: (v: string) => void;
}) {
  const [selectedFile, setSelectedFile] = useState(contracts[0]?.name || "AgentSmartAccount.sol");
  const activeContract = contracts.find((c) => c.name === selectedFile);

  const copyCode = (text: string, label: string) => {
    void navigator.clipboard.writeText(text).then(() => setNotice(`Copied ${label}`)).catch(() => setNotice("Could not copy. Select the source text and copy it manually."));
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
      <div className="bg-white rounded-xl border border-[#e7e5e4] p-3 shadow-xs h-fit space-y-1">
        <span className="text-xs font-semibold text-[#78716c] block mb-2 px-2">
          Contracts
        </span>
        {(contracts.length > 0
          ? contracts
          : [
              { name: "AgentSmartAccount.sol", source: "", abi: [], bytecodeLength: 6420 },
              { name: "PolicyEngine.sol", source: "", abi: [], bytecodeLength: 8120 },
              { name: "AgentPaymaster.sol", source: "", abi: [], bytecodeLength: 4320 },
              { name: "GuardianRecoveryModule.sol", source: "", abi: [], bytecodeLength: 5120 },
            ]
        ).map((c) => (
          <button
            key={c.name}
            onClick={() => setSelectedFile(c.name)}
            className={`w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors ${
              selectedFile === c.name
                ? "bg-[#1c1917] text-white font-medium"
                : "text-[#44403c] hover:bg-[#f5f5f4]"
            }`}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="md:col-span-3 bg-white rounded-xl border border-[#e7e5e4] p-5 shadow-xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#f5f5f4]">
          <div className="flex items-center gap-2">
            <span className="mono text-xs font-medium text-[#78716c]">Solidity 0.8.24</span>
            <h3 className="text-sm font-semibold text-[#1c1917]">{selectedFile}</h3>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => copyCode(activeContract?.source || "", selectedFile)}
              className="px-2.5 py-1 bg-[#f5f5f4] hover:bg-[#e7e5e4] text-[#44403c] text-xs font-medium rounded-md"
            >
              Copy source
            </button>
            <button
              onClick={() => copyCode(JSON.stringify(activeContract?.abi || [], null, 2), `${selectedFile} ABI`)}
              className="px-2.5 py-1 bg-[#f5f5f4] hover:bg-[#e7e5e4] text-[#44403c] text-xs font-medium rounded-md"
            >
              Copy ABI
            </button>
          </div>
        </div>

        <pre className="p-4 bg-[#fafaf9] border border-[#e7e5e4] text-[#292524] rounded-lg text-xs font-mono leading-relaxed max-h-[500px] overflow-auto">
          <code>{activeContract?.source || "// Loading contract source..."}</code>
        </pre>
      </div>
    </div>
  );
}
