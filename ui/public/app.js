// QA Investigator UI — vanilla JS, no build step. Every server value is escaped before rendering.
const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const SEV = ["critical", "high", "medium", "low", "info"];
const SEV_COLOR = { critical: "var(--crit)", high: "var(--high)", medium: "var(--med)", low: "var(--low)", info: "var(--muted)" };
let pollTimer = null;
let feedSince = 0;

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || (data.errors || []).join("; ") || r.statusText), { data, status: r.status });
  return data;
}
const fileUrl = (run, rel) => `/files/${run.source}/${encodeURIComponent(run.id)}/${rel.split("/").map(encodeURIComponent).join("/")}`;
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString() : "");
const date = (iso) => (iso ? new Date(iso).toLocaleString() : "");

// ------------------------------------------------------------------ router
function route() {
  clearInterval(pollTimer);
  const [, page = "dashboard", a, b] = location.hash.split("/");
  document.querySelectorAll("[data-nav]").forEach((n) => n.classList.toggle("active", n.dataset.nav === (page === "run" ? "findings" : page)));
  const pages = { dashboard, new: newInvestigation, findings, reports, run: () => runPage(a, b) };
  (pages[page] || dashboard)();
  view.focus();
}
window.addEventListener("hashchange", route);

async function refreshStatus() {
  try {
    const s = await api("/api/status");
    $("#status-foot").innerHTML = `${s.claude ? `<span class="ok">●</span> ${esc(s.claude)}` : '<span class="bad">●</span> claude not found'}<br>${s.built ? '<span class="ok">●</span> MCP server built' : '<span class="bad">●</span> run npm run build'}<br>${s.running ? `<span class="ok">●</span> run ${esc(s.running)} active` : '<span class="muted">●</span> idle'}`;
    return s;
  } catch {
    $("#status-foot").textContent = "UI server unreachable";
    return null;
  }
}

// --------------------------------------------------------------- dashboard
async function dashboard() {
  view.innerHTML = `<h1>Dashboard</h1><p class="sub">Investigations recorded by the qa-investigator MCP server.</p><div id="dash" class="empty">Loading…</div>`;
  const [{ runs }, cur] = await Promise.all([api("/api/runs"), api("/api/investigations/current")]);
  const totals = Object.fromEntries(SEV.map((s) => [s, runs.reduce((n, r) => n + (r.bySeverity[s] || 0), 0)]));
  const confirmed = runs.reduce((n, r) => n + (r.byStatus.Confirmed || 0), 0);
  const all = runs.reduce((n, r) => n + r.findings, 0);
  $("#dash").outerHTML = `
    ${cur.run ? `<div class="card" style="margin-bottom:14px"><div class="row"><b>Latest UI run</b><span class="pill ${esc(cur.run.status)}">${esc(cur.run.status)}</span><span class="muted">${esc(cur.run.form.url)} · started ${esc(time(cur.run.startedAt))}</span><a href="#/new">View progress</a>${cur.run.missionId ? `<a href="#/run/runs/${encodeURIComponent(cur.run.missionId)}">Results</a>` : ""}</div></div>` : ""}
    <div class="grid cols-4">
      <div class="card stat"><div class="k">Missions</div><div class="v">${runs.length}</div><div class="d">runs/ and examples/</div></div>
      <div class="card stat"><div class="k">Findings</div><div class="v">${all}</div><div class="d">${confirmed} confirmed by re-check</div></div>
      <div class="card stat"><div class="k">Critical + High</div><div class="v">${totals.critical + totals.high}</div><div class="d">${totals.critical} critical · ${totals.high} high</div></div>
      <div class="card stat"><div class="k">Reports</div><div class="v">${runs.filter((r) => r.hasReport).length}</div><div class="d">HTML reports generated</div></div>
    </div>
    <div class="card" style="margin-top:14px"><h2>Recent missions</h2>${runsTable(runs.slice(0, 8))}</div>`;
}

function runsTable(runs) {
  if (!runs.length) return '<div class="empty">No missions yet. Start one from New Investigation.</div>';
  return `<div class="tbl"><table><thead><tr><th>Mission</th><th>Target</th><th>Started</th><th>Findings</th><th>Severity</th><th>Report</th></tr></thead><tbody>${runs
    .map(
      (r) => `<tr class="click" data-href="#/run/${r.source}/${encodeURIComponent(r.id)}"><td><b>${esc(r.name)}</b><br><span class="muted">${esc(r.source)}/${esc(r.id)}</span></td><td>${esc(r.target)}</td><td>${esc(date(r.createdAt))}</td><td>${r.findings}</td><td>${SEV.filter((s) => r.bySeverity[s]).map((s) => `<span class="sev ${s}">${r.bySeverity[s]} ${s}</span>`).join(" ") || '<span class="muted">—</span>'}</td><td>${r.hasReport ? `<a href="${fileUrl(r, "report.html")}" target="_blank" rel="noopener">Open</a>` : '<span class="muted">none</span>'}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}
view.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-href]");
  if (tr && !e.target.closest("a")) location.hash = tr.dataset.href;
});

// -------------------------------------------------------- new investigation
function newInvestigation() {
  view.innerHTML = `<h1>New Investigation</h1><p class="sub">Starts a headless Claude Code session that may use only the qa-investigator tools. Only test sites you own or are authorised to test.</p>
  <div class="grid cols-2">
    <form class="card" id="inv-form" novalidate>
      <h2>Mission</h2>
      <label for="url">Website URL</label><input id="url" type="url" required placeholder="https://staging.example.com">
      <label for="extraHosts">Additional allowed hosts <span class="hint">optional, comma separated (e.g. api.example.com)</span></label><input id="extraHosts" type="text" placeholder="api.example.com">
      <label for="authorization">Authorization statement</label><textarea id="authorization" required placeholder="I own this site / the owner approved functional, API and non-destructive security testing on …"></textarea>
      <label for="authorizedBy">Authorized by</label><input id="authorizedBy" type="text" required placeholder="Name or team">
      <label id="env-label">Environment</label>
      <div class="seg" role="radiogroup" aria-labelledby="env-label">
        <label><input type="radio" name="environment" value="local" checked> Local</label>
        <label><input type="radio" name="environment" value="staging"> Staging</label>
        <label><input type="radio" name="environment" value="production"> Production</label>
      </div>
      <label id="scope-label">Testing scope</label>
      <div class="checks" role="group" aria-labelledby="scope-label">
        ${["functional", "ui", "api", "security", "integration"].map((s) => `<label><input type="checkbox" name="scope" value="${s}" checked> ${s === "ui" ? "UI" : s === "api" ? "API" : s[0].toUpperCase() + s.slice(1)}</label>`).join("")}
      </div>
      <label for="objective">Testing objective</label><textarea id="objective" required placeholder="What the app does, which workflows matter most, what this investigation should establish."></textarea>
      <label class="toggle"><input type="checkbox" id="readOnly" checked> Read-only mode <span class="hint">(GET/HEAD/OPTIONS only; always on for Production)</span></label>
      <div class="errors" id="form-errors" role="alert"></div>
      <div class="row" style="margin-top:16px"><button class="btn" id="start" type="submit">Start Investigation</button><button class="btn danger" id="cancel" type="button" hidden>Cancel run</button></div>
      <div class="notice">Credentials are never entered here. Pages that need a login are recorded as blocked unless test-account secrets are configured server-side.</div>
    </form>
    <section class="card" aria-labelledby="prog-h">
      <div class="row" style="justify-content:space-between"><h2 id="prog-h" style="margin:0">Live progress</h2><span id="run-pill"></span></div>
      <p class="muted" id="run-meta" style="margin:6px 0 10px">No investigation started in this UI session.</p>
      <div class="feed" id="feed" aria-live="polite"></div>
      <div class="row" id="run-links" style="margin-top:10px"></div>
    </section>
  </div>`;
  const form = $("#inv-form");
  const ro = $("#readOnly");
  form.addEventListener("change", () => {
    const prod = form.environment.value === "production";
    if (prod) ro.checked = true;
    ro.disabled = prod;
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#form-errors").textContent = "";
    const body = {
      url: $("#url").value,
      extraHosts: $("#extraHosts").value,
      authorization: $("#authorization").value,
      authorizedBy: $("#authorizedBy").value,
      environment: form.environment.value,
      scope: [...form.querySelectorAll("input[name=scope]:checked")].map((c) => c.value),
      objective: $("#objective").value,
      readOnly: ro.checked,
    };
    $("#start").disabled = true;
    try {
      await api("/api/investigations", { method: "POST", body: JSON.stringify(body) });
      feedSince = 0;
      $("#feed").innerHTML = "";
      startPolling();
    } catch (err) {
      $("#form-errors").innerHTML = err.data?.errors ? `<ul style="margin:0;padding-left:18px">${err.data.errors.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : esc(err.message);
      $("#start").disabled = false;
    }
  });
  $("#cancel").addEventListener("click", async () => {
    if (!confirm("Stop the running investigation? Work recorded so far stays in runs/.")) return;
    await api("/api/investigations/current/cancel", { method: "POST", body: "{}" }).catch((e) => alert(e.message));
  });
  feedSince = 0;
  startPolling();
}

function startPolling() {
  clearInterval(pollTimer);
  const tick = async () => {
    let data;
    try {
      data = await api(`/api/investigations/current?since=${feedSince}`);
    } catch {
      return;
    }
    const run = data.run;
    if (!run || !$("#feed")) return;
    const feed = $("#feed");
    const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 30;
    for (const ev of run.events) {
      const div = document.createElement("div");
      div.className = `ev ${ev.kind}`;
      const tag = ev.kind === "tool" ? ev.tool : ev.kind === "tool-result" ? "result" : ev.kind === "tool-error" ? "tool error" : ev.kind;
      div.innerHTML = `<time>${esc(time(ev.at))}</time><span class="tag">${esc(tag)}</span><span class="txt">${esc(ev.text)}</span>`;
      feed.appendChild(div);
    }
    feedSince = run.totalEvents;
    if (atBottom) feed.scrollTop = feed.scrollHeight;
    $("#run-pill").innerHTML = `<span class="pill ${esc(run.status)}">${esc(run.status)}</span>`;
    $("#run-meta").textContent = `${run.form.url} · ${run.form.environment} · ${run.form.readOnly ? "read-only" : "state-changing allowed"} · started ${time(run.startedAt)}${run.missionId ? ` · mission ${run.missionId}` : ""}`;
    const running = run.status === "running";
    if ($("#start")) $("#start").disabled = running;
    if ($("#cancel")) $("#cancel").hidden = !running;
    $("#run-links").innerHTML = run.missionId
      ? `<a class="btn ghost" href="#/run/runs/${encodeURIComponent(run.missionId)}">View results</a>${!running ? `<a class="btn ghost" href="/files/runs/${encodeURIComponent(run.missionId)}/report.html" target="_blank" rel="noopener">Open HTML report</a>` : ""}`
      : "";
    if (!running) {
      clearInterval(pollTimer);
      refreshStatus();
    }
  };
  tick();
  pollTimer = setInterval(tick, 1500);
}

// ------------------------------------------------------------ results / run
async function runPage(source, id) {
  view.innerHTML = '<div class="empty">Loading…</div>';
  let r;
  try {
    r = await api(`/api/runs/${source}/${id}`);
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const f = r.findings;
  const sevCount = Object.fromEntries(SEV.map((s) => [s, f.filter((x) => x.severity === s).length]));
  const stCount = ["Confirmed", "Potential", "Not Reproduced", "Blocked"].map((s) => `${s} <b>${f.filter((x) => x.status === s).length}</b>`).join(" · ");
  const cov = r.coverage || {};
  const metrics = cov.metrics ? Object.entries(cov.metrics) : [];
  view.innerHTML = `
    <div class="row" style="justify-content:space-between"><div><h1>${esc(r.mission.name)}</h1><p class="sub">${esc(r.mission.targetUrls.join(", "))} · ${esc(r.mission.environment)} · ${esc(r.mission.allowedMethods.join("/"))} · ${esc(date(r.mission.createdAt))}</p></div>
    <div class="row">${r.hasReport ? `<a class="btn" href="${fileUrl(r, "report.html")}" target="_blank" rel="noopener">Open HTML report</a>` : '<span class="muted">No report generated yet</span>'}</div></div>
    <div class="card" style="margin-bottom:14px"><b>Authorization:</b> ${esc(r.mission.authorization.statement)} — ${esc(r.mission.authorization.authorizedBy)}<br><span class="muted">${esc(r.mission.objective)}</span></div>
    <div class="sevbar">${SEV.map((s) => `<div class="sevbox" style="border-left-color:${SEV_COLOR[s]}"><b>${sevCount[s]}</b><span>${s}</span></div>`).join("")}</div>
    <p class="muted">Verification status: ${stCount}</p>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h2>Coverage</h2>${cov.error ? `<p class="bad">${esc(cov.error)}</p>` : metrics.map(([k, v]) => `<div class="metric"><div style="flex:1"><div>${esc(k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()))}</div><div class="bar"><i style="width:${v.denominator ? v.percent : 0}%"></i></div></div><div><b>${v.denominator ? `${v.percent}%` : "n/a"}</b> <span class="muted">${v.numerator}/${v.denominator}</span></div></div>`).join("")}<p class="muted" style="font-size:12px">${esc(cov.disclaimer || "")}</p></div>
      <div class="card"><h2>Coverage by category</h2>${cov.byCategory ? `<div class="tbl"><table><thead><tr><th>Category</th><th>Planned</th><th>Passed</th><th>Failed</th><th>Blocked</th><th>Not tested</th><th>Defects</th></tr></thead><tbody>${cov.byCategory.map((c) => `<tr class="${c.applicable ? "" : "muted"}"><td>${esc(c.category)}</td><td>${c.planned}</td><td class="ok">${c.passed}</td><td class="bad">${c.failed}</td><td>${c.blocked}</td><td>${c.notTested}</td><td>${c.defects}</td></tr>`).join("")}</tbody></table></div>` : ""}</div>
    </div>
    ${cov.gaps ? `<div class="card" style="margin-top:14px"><h2>Blocked and untested</h2>${gapsHtml(cov.gaps)}</div>` : ""}
    <div class="card" style="margin-top:14px"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Findings (${f.length})</h2>
      <div class="row"><label for="fsev" class="hint" style="margin:0">Severity</label><select id="fsev" style="width:auto"><option value="">All</option>${SEV.map((s) => `<option>${s}</option>`).join("")}</select>
      <label for="fst" class="hint" style="margin:0">Status</label><select id="fst" style="width:auto"><option value="">All</option><option>Confirmed</option><option>Potential</option><option>Not Reproduced</option><option>Blocked</option></select></div></div>
      <div id="flist"></div></div>`;
  const render = () => {
    const sv = $("#fsev").value;
    const st = $("#fst").value;
    const list = f.filter((x) => (!sv || x.severity === sv) && (!st || x.status === st)).sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
    $("#flist").innerHTML = list.length ? list.map((x) => findingCard(r, x)).join("") : '<div class="empty">No findings match.</div>';
  };
  $("#fsev").onchange = render;
  $("#fst").onchange = render;
  render();
}

function gapsHtml(g) {
  const items = [
    ...g.blocked.map((x) => `<li><b>Blocked</b> ${esc(x.id)} ${esc(x.title)} — ${esc(x.reason)}</li>`),
    ...g.partial.map((x) => `<li><b>Partial</b> ${esc(x.id)} ${esc(x.title)} — ${esc(x.observation)}</li>`),
    ...g.notTested.map((x) => `<li><b>Not tested</b> ${esc(x.id)} ${esc(x.title)} — ${esc(x.reason)}</li>`),
    ...g.untestedEndpoints.map((x) => `<li><b>Endpoint not exercised</b> ${esc(x)}</li>`),
  ];
  return items.length ? `<ul>${items.join("")}</ul>` : '<p class="muted">None recorded (reflects recorded scenarios only).</p>';
}

function findingCard(r, x) {
  const evLinks = x.evidenceIds
    .map((id) => {
      const e = r.evidence[id];
      if (!e) return `<span class="muted">${esc(id)}</span>`;
      const href = fileUrl(r, e.file);
      return e.file.endsWith(".png") ? `<a href="${href}" target="_blank" rel="noopener"><img src="${href}" alt="${esc(`${id} ${e.label}`)}" loading="lazy">${esc(id)}</a>` : `<a href="${href}" target="_blank" rel="noopener">${esc(id)} · ${esc(e.kind)}</a>`;
    })
    .join("");
  const last = x.verifications[x.verifications.length - 1];
  return `<details class="finding"><summary><span class="sev ${esc(x.severity)}">${esc(x.severity)}</span> <span class="pill">${esc(x.priority)}</span> <span class="st ${esc(x.status.replace(/\s/g, ""))}">${esc(x.status)}${x.securityConfidence ? ` · ${esc(x.securityConfidence)}` : ""}</span> <b>${esc(x.id)}</b> ${esc(x.title)}</summary>
    <dl>
      <dt>Category</dt><dd>${esc(x.category)}</dd>
      <dt>Resource</dt><dd><code>${esc(x.affectedEndpoint || x.affectedUrl)}</code></dd>
      <dt>Steps</dt><dd><ol>${x.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></dd>
      <dt>Expected</dt><dd>${esc(x.expected)} <span class="muted">(source: ${esc(x.expectedSource)})</span></dd>
      <dt>Actual</dt><dd>${esc(x.actual)}</dd>
      <dt>Impact</dt><dd>${esc(x.impact)}</dd>
      <dt>Severity rationale</dt><dd>${esc(x.severityRationale)}</dd>
      <dt>Verification</dt><dd>${last ? `${esc(last.method)}: reproduced ${last.reproduced}/${last.attempts} → <b>${esc(last.resultingStatus)}</b> (${x.verifications.length} run${x.verifications.length > 1 ? "s" : ""})` : '<span class="bad">Not verified</span>'}</dd>
      <dt>Follow-up</dt><dd>${esc(x.suggestedFollowUp)}</dd>
    </dl><div class="ev-links">${evLinks}</div></details>`;
}

// ---------------------------------------------------------- findings list
async function findings() {
  view.innerHTML = `<h1>Findings</h1><p class="sub">Pick a mission to see its findings, verification status, evidence and coverage.</p><div class="card" id="fl">Loading…</div>`;
  const { runs } = await api("/api/runs");
  const withFindings = runs.filter((r) => r.findings > 0);
  $("#fl").innerHTML = withFindings.length ? runsTable(withFindings) : '<div class="empty">No findings recorded yet.</div>';
}

// ---------------------------------------------------------------- reports
async function reports() {
  view.innerHTML = `<h1>Reports</h1><p class="sub">Reports generated by generate_qa_report. Files open from the mission folder; evidence links inside the report work.</p><div class="card" id="rl">Loading…</div>`;
  const { runs } = await api("/api/runs");
  const withReport = runs.filter((r) => r.hasReport);
  $("#rl").innerHTML = withReport.length
    ? `<div class="tbl"><table><thead><tr><th>Mission</th><th>Target</th><th>Started</th><th>Findings</th><th>Files</th></tr></thead><tbody>${withReport
        .map(
          (r) => `<tr><td><a href="#/run/${r.source}/${encodeURIComponent(r.id)}"><b>${esc(r.name)}</b></a><br><span class="muted">${esc(r.source)}/${esc(r.id)}</span></td><td>${esc(r.target)}</td><td>${esc(date(r.createdAt))}</td><td>${r.findings}</td><td class="row"><a href="${fileUrl(r, "report.html")}" target="_blank" rel="noopener">HTML report</a> <a href="${fileUrl(r, "summary.md")}" target="_blank" rel="noopener">summary.md</a> <a href="${fileUrl(r, "coverage-matrix.md")}" target="_blank" rel="noopener">coverage-matrix.md</a> <a href="${fileUrl(r, "findings.json")}" target="_blank" rel="noopener">findings.json</a></td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : '<div class="empty">No reports yet. A report is written when an investigation finishes with generate_qa_report.</div>';
}

refreshStatus();
setInterval(refreshStatus, 10000);
if (!location.hash) location.hash = "#/dashboard";
else route();
