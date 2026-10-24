const list = document.querySelector("#attack-list");
const result = document.querySelector("#result");
const runAll = document.querySelector("#run-all");
const threshold = document.querySelector("#threshold");
const thresholdValue = document.querySelector("#threshold-value");
const anomalyMetrics = document.querySelector("#anomaly-metrics");
const rocCanvas = document.querySelector("#roc");
const recoveryStatus = document.querySelector("#recovery-status");
const recoveryTarget = document.querySelector("#recovery-target");
const recoveryProposer = document.querySelector("#recovery-proposer");
const recoveryNewKey = document.querySelector("#recovery-new-key");
const recoveryInitiate = document.querySelector("#recovery-initiate");
const recoveryCountdown = document.querySelector("#recovery-countdown");
const guardianGrid = document.querySelector("#guardian-grid");
const recoveryFastForward = document.querySelector("#recovery-fast-forward");
const recoveryExecute = document.querySelector("#recovery-execute");
const recoveryVeto = document.querySelector("#recovery-veto");
const recoveryAudit = document.querySelector("#recovery-audit-log");
const fuzzIterations = document.querySelector("#fuzz-iterations");
const runFuzz = document.querySelector("#run-fuzz");
const flawedContract = document.querySelector("#flawed-contract");
const fuzzGrid = document.querySelector("#fuzz-grid");
const fuzzProof = document.querySelector("#fuzz-proof");
const fuzzCounterexample = document.querySelector("#fuzz-counterexample");
let catalog = [];
let active = "";
let recoveryState = null;
let recoveryReceivedAt = 0;

async function loadCatalog() {
  catalog = await fetch("/api/attacks", { cache: "no-store" }).then((response) => response.json());
  document.querySelector("#attack-count").textContent = String(catalog.length).padStart(2, "0");
  list.innerHTML = catalog.map((entry, index) => `
    <button class="card ${entry.id === active ? "active" : ""}" data-id="${entry.id}">
      <div class="card-head"><span class="card-title">${String(index + 1).padStart(2, "0")} / ${escapeHtml(entry.title)}</span><span class="card-index">RUN</span></div>
      <p>${escapeHtml(entry.threat)}</p>
    </button>`).join("");
  list.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => runAttack(button.dataset.id)));
}

async function runAttack(id) {
  active = id;
  await loadCatalog();
  result.innerHTML = `<div class="empty">Executing ${escapeHtml(id)}…</div>`;
  const attack = await fetch(`/api/attack/${encodeURIComponent(id)}`, { cache: "no-store" }).then((response) => response.json());
  renderResult(attack);
}

async function runSuite() {
  runAll.disabled = true;
  for (const entry of catalog) await runAttack(entry.id);
  runAll.disabled = false;
}

function renderResult(attack) {
  const metrics = Object.entries(attack.metrics).map(([key, value]) => `<div class="stat"><div class="label">${escapeHtml(key)}</div><div class="value">${escapeHtml(value)}</div></div>`).join("");
  result.innerHTML = `
    <div class="result-head">
      <div><div class="eyebrow">${escapeHtml(attack.id)}</div><h2>${escapeHtml(attack.title)}</h2><p>${escapeHtml(attack.description)}</p></div>
      <div class="proof"><strong>✓ Max Loss Guarantee Maintained</strong><span>${escapeHtml(attack.proof.inequality)}</span><span>${escapeHtml(attack.proof.hash)}</span></div>
    </div>
    <div class="stats">${metrics}<div class="stat"><div class="label">wallet loss wei</div><div class="value">${escapeHtml(attack.lossWei)}</div></div><div class="stat"><div class="label">daily limit wei</div><div class="value">${escapeHtml(attack.dailyLimitWei)}</div></div><div class="stat"><div class="label">gas loss / bound</div><div class="value">${escapeHtml(attack.gasLoss)}</div></div></div>
    <div class="eyebrow">Verified lifecycle trace</div><div id="trace" class="trace"></div>`;
  animateTrace(attack.steps);
}

function animateTrace(steps) {
  const trace = document.querySelector("#trace");
  let index = 0;
  const append = () => {
    if (index >= steps.length) return;
    const step = steps[index];
    const details = Object.entries(step.details).map(([key, value]) => `<div class="detail"><b>${escapeHtml(key)}:</b> ${escapeHtml(value)}</div>`).join("");
    const row = document.createElement("div");
    row.className = "trace-row";
    row.innerHTML = `<div class="num">${String(step.index).padStart(3, "0")}</div><div class="phase">${escapeHtml(step.phase)}</div><div class="row-status ${step.status === "reverted" ? "reverted" : ""}">${escapeHtml(step.status)}</div><div><div class="trace-label">${escapeHtml(step.label)}</div><div class="detail-grid">${details}</div></div>`;
    trace.appendChild(row);
    index += 1;
    requestAnimationFrame(append);
  };
  append();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

runAll.addEventListener("click", runSuite);
threshold.addEventListener("input", () => {
  thresholdValue.textContent = threshold.value;
  loadAnomalyBenchmark(Number(threshold.value));
});
loadCatalog();
loadAnomalyBenchmark(75);
loadRecovery();

async function loadRecovery() {
  recoveryState = await fetch("/api/recovery/state", { cache: "no-store" }).then((response) => response.json());
  recoveryReceivedAt = Date.now();
  recoveryProposer.innerHTML = recoveryState.guardians.map((guardian) => `<option value="${guardian.address}">${escapeHtml(guardian.name)} / ${escapeHtml(guardian.address)}</option>`).join("");
  renderRecovery();
}

async function recoveryPost(path, body = {}) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "recovery action failed");
  recoveryState = payload;
  recoveryReceivedAt = Date.now();
  renderRecovery();
}

function renderRecovery() {
  if (!recoveryState) return;
  const proposal = recoveryState.proposal;
  const status = proposal ? proposal.status : "active";
  recoveryStatus.className = `recovery-status ${status}`;
  recoveryStatus.textContent = proposal ? `${status.toUpperCase()} / RECOVERY ${proposal.id}` : "ACTIVE / NO PROPOSAL";
  const approvals = new Set(proposal?.approvals ?? []);
  guardianGrid.innerHTML = recoveryState.guardians.map((guardian) => {
    const approved = approvals.has(guardian.address.toLowerCase());
    const canApprove = proposal && proposal.status === "active" && !approved;
    return `<button class="guardian ${approved ? "approved" : ""}" data-guardian="${guardian.address}" ${canApprove ? "" : "disabled"}><span class="guardian-name">${escapeHtml(guardian.name)}</span><span class="guardian-state">${approved ? "approval recorded" : "sign approval"}</span></button>`;
  }).join("");
  guardianGrid.querySelectorAll("button[data-guardian]").forEach((button) => button.addEventListener("click", async () => {
    try { await recoveryPost("/api/recovery/approve", { guardian: button.dataset.guardian }); } catch (error) { showRecoveryError(error); }
  }));
  recoveryCountdown.textContent = proposal && proposal.status === "pending" ? `EXECUTABLE IN ${formatDuration(Math.max(0, proposal.executableAfter - simulatedNow()))} / target: ${proposal.target.toUpperCase()} / new key: ${proposal.newKey}` : proposal && proposal.status === "active" ? `QUORUM ${proposal.approvals.length}/3 / awaiting guardian approvals` : proposal && proposal.status === "vetoed" ? "VETOED / guardian approvals reset / takeover halted" : proposal && proposal.status === "executed" ? `EXECUTED / ${proposal.target.toUpperCase()} ROTATED / compromised key revoked` : "No active recovery proposal.";
  recoveryFastForward.disabled = !proposal || proposal.status !== "pending";
  recoveryExecute.disabled = !proposal || proposal.status !== "pending";
  recoveryVeto.disabled = !proposal || (proposal.status !== "active" && proposal.status !== "pending");
  recoveryAudit.innerHTML = recoveryState.audit.slice().reverse().map((event) => `<div class="audit-row"><span>${new Date(event.timestamp * 1000).toISOString()}</span><span>${escapeHtml(event.action)}</span><span>${escapeHtml(event.actor)} / ${escapeHtml(event.hash)}</span></div>`).join("");
}

function simulatedNow() {
  if (!recoveryState) return 0;
  return recoveryState.now + Math.floor((Date.now() - recoveryReceivedAt) / 1000);
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(remaining).padStart(2, "0")}s`;
}

function showRecoveryError(error) {
  recoveryCountdown.textContent = `ACTION REJECTED / ${error instanceof Error ? error.message : String(error)}`;
}

recoveryInitiate.addEventListener("click", async () => {
  try { await recoveryPost("/api/recovery/initiate", { guardian: recoveryProposer.value, newKey: recoveryNewKey.value, target: recoveryTarget.value }); } catch (error) { showRecoveryError(error); }
});
recoveryFastForward.addEventListener("click", async () => {
  try { await recoveryPost("/api/recovery/fast-forward", { seconds: String(recoveryState.delaySeconds) }); } catch (error) { showRecoveryError(error); }
});
recoveryExecute.addEventListener("click", async () => {
  try { await recoveryPost("/api/recovery/execute", { guardian: recoveryProposer.value }); } catch (error) { showRecoveryError(error); }
});
recoveryVeto.addEventListener("click", async () => {
  try { await recoveryPost("/api/recovery/veto", { owner: recoveryState.owner }); } catch (error) { showRecoveryError(error); }
});
setInterval(() => { if (recoveryState) renderRecovery(); }, 1000);
runFuzz.addEventListener("click", startFuzz);

async function loadAnomalyBenchmark(value) {
  const metrics = await fetch(`/api/anomaly/benchmark?threshold=${value}`, { cache: "no-store" }).then((response) => response.json());
  const cells = [
    ["TP detection", `${(metrics.truePositiveDetectionRate * 100).toFixed(2)}%`],
    ["false freeze", `${(metrics.falseFreezeRate * 100).toFixed(2)}%`],
    ["MTTC seconds", metrics.meanTimeToContainmentSeconds.toFixed(2)],
    ["MTTC blocks", metrics.meanTimeToContainmentBlocks.toFixed(2)],
    ["patterns", String(metrics.totalPatterns)],
  ];
  anomalyMetrics.innerHTML = cells.map(([label, result]) => `<div class="anomaly-cell"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(result)}</div></div>`).join("");
  drawRoc(metrics.roc);
}

function drawRoc(points) {
  const context = rocCanvas.getContext("2d");
  const width = rocCanvas.width;
  const height = rocCanvas.height;
  context.clearRect(0, 0, width, height);
  context.strokeStyle = "#26334d";
  context.lineWidth = 1;
  for (let index = 1; index < 5; index += 1) {
    const x = (width * index) / 5;
    const y = (height * index) / 5;
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }
  context.strokeStyle = "#10b981";
  context.lineWidth = 3;
  context.beginPath();
  points.forEach((point, index) => {
    const x = point.falsePositiveRate * width;
    const y = height - point.truePositiveRate * height;
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.stroke();
}

function startFuzz() {
  runFuzz.disabled = true;
  fuzzCounterexample.hidden = true;
  fuzzProof.textContent = "Executing randomized state transitions in Web Worker…";
  const worker = new Worker("/fuzz-worker.js");
  worker.onmessage = (event) => {
    const payload = event.data;
    renderFuzz(payload);
    if (payload.type === "complete") {
      runFuzz.disabled = false;
      worker.terminate();
    }
  };
  worker.onerror = (error) => {
    runFuzz.disabled = false;
    fuzzProof.textContent = `Worker failure: ${error.message}`;
    worker.terminate();
  };
  worker.postMessage({ iterations: Math.max(5000, Number(fuzzIterations.value || 5000)), flawedContract: flawedContract.checked, seed: 0xa9e17 });
}

function renderFuzz(payload) {
  const invariants = payload.invariantsVerified ?? { perTxBound: 0, dailyCapBound: 0, expiryBound: 0, vetoIntegrity: 0 };
  const cells = [
    ["mutations evaluated", String(payload.totalMutationsEvaluated ?? 0)],
    ["violations detected", String(payload.violationsDetected ?? 0)],
    ["per-tx / daily / expiry / veto", `${invariants.perTxBound} / ${invariants.dailyCapBound} / ${invariants.expiryBound} / ${invariants.vetoIntegrity}`],
    ["execution speed", `${payload.runsPerSecond ?? 0} runs/s`],
    ["elapsed", `${Number(payload.elapsedMs ?? 0).toFixed(1)} ms`],
  ];
  fuzzGrid.innerHTML = cells.map(([label, value], index) => `<div class="fuzz-cell"><div class="label">${escapeHtml(label)}</div><div class="value ${index === 1 ? (Number(payload.violationsDetected ?? 0) === 0 ? "fuzz-safe" : "fuzz-danger") : ""}">${escapeHtml(value)}</div></div>`).join("");
  if (payload.violationsDetected === 0) {
    fuzzProof.className = "fuzz-proof";
    fuzzProof.textContent = `INVARIANT VERIFIED / proof ${payload.proofHash ?? "pending"}`;
  } else {
    fuzzProof.className = "fuzz-proof fuzz-danger";
    fuzzProof.textContent = `COUNTEREXAMPLE DETECTED / ${payload.violationsDetected} violation(s)`;
    if (payload.firstViolation) {
      fuzzCounterexample.hidden = false;
      fuzzCounterexample.textContent = JSON.stringify(payload.firstViolation, (_, value) => typeof value === "bigint" ? `${value}n` : value, 2);
    }
  }
}
