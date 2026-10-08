#!/usr/bin/env node
// Generates docs/brain/PLAN-PROGRESS.html from .planning/REFAL-BRAIN-MASTER-PLAN.md.
//
// The plan markdown is the single source of truth. This script only reads it,
// so the UI can never drift from the plan: tick a phase to `[x]` in the plan,
// re-run this, refresh the page.
//
//   node scripts/buildPlanProgress.js        (or: npm run plan:ui)

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PLAN = path.join(ROOT, ".planning", "REFAL-BRAIN-MASTER-PLAN.md");
const OUT = path.join(ROOT, "docs", "brain", "PLAN-PROGRESS.html");

const STATUS = {
  " ": { key: "todo", label: "Not started", order: 0 },
  "~": { key: "doing", label: "In progress", order: 1 },
  x: { key: "done", label: "Done", order: 2 }
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Strip the markdown emphasis/code noise the plan uses in headings so the UI
// shows a clean title rather than raw markup.
function cleanTitle(value) {
  return String(value || "")
    .replace(/`\[[ x~]\]`/g, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    // Plan-internal provenance notes ("(imported from CX Phase 13)",
    // "(removes BLK-3)") are useful in the document and noise in the UI.
    .replace(/\((?:imported|removes|repairs|fixes)[^)]*\)/gi, "")
    .replace(/\s*—\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parsePlan(markdown) {
  const lines = markdown.split(/\r?\n/);
  const milestones = [];
  let milestone = null;
  let phase = null;
  let inDbBlock = false;

  for (const line of lines) {
    // A numbered "## 13. …" section ends the milestone run. Without this the
    // completion-log entries in section 16 are parsed as duplicate phases and
    // attach themselves to the last milestone.
    if (/^##\s+\d+\.\s/.test(line)) {
      milestone = null;
      phase = null;
      continue;
    }

    const m = /^#\s+(M\d+)\s*—\s*(.+)$/.exec(line);
    if (m) {
      milestone = { id: m[1], title: cleanTitle(m[2]), phases: [], exit: "", dbChanges: [] };
      milestones.push(milestone);
      phase = null;
      inDbBlock = false;
      continue;
    }

    const p = /^###\s+(P\d+\.\d+)\s*—\s*(.+)$/.exec(line);
    if (p && milestone) {
      const rest = p[2];
      const mark = /`\[([ x~])\]`/.exec(rest);
      phase = {
        id: p[1],
        title: cleanTitle(rest),
        status: STATUS[mark ? mark[1] : " "] || STATUS[" "],
        waves: 0,
        waveList: []
      };
      milestone.phases.push(phase);
      inDbBlock = false;
      continue;
    }

    // "**Exit criteria.** ..." is the one-line promise of each milestone.
    if (milestone && !milestone.exit && /^\*\*Exit criteria\.?\*\*/.test(line)) {
      milestone.exit = cleanTitle(line.replace(/^\*\*Exit criteria\.?\*\*\s*/, ""));
      continue;
    }

    // "**Database changes (apply in order).**" opens an ordered list of the
    // .sql files BOSS must run for this milestone, in sequence. The block ends
    // at the first line that is not a numbered item or blank.
    if (milestone && /^\*\*Database changes[^*]*\*\*/i.test(line.trim())) {
      inDbBlock = true;
      continue;
    }
    if (inDbBlock) {
      const item = /^\d+\.\s+`([^`]+)`\s*(?:—\s*(.*))?$/.exec(line.trim());
      if (item) {
        milestone.dbChanges.push({ file: item[1], note: cleanTitle(item[2] || "") });
        continue;
      }
      if (line.trim() !== "") inDbBlock = false;
    }

    // Waves appear either as a table row ("| **W1.1.1** | ... |") or as a
    // bullet ("- **W2.4.1** ..."). Count each wave id once.
    //
    // A wave may carry its own `[x]` / `[~]` / `[ ]` mark. When it does not, it
    // INHERITS the phase status, so ticking a phase to [x] marks all its waves
    // done without having to touch every row.
    if (phase) {
      const row = line.trim();
      const wave = /^[|\-*]\s*\*\*(W\d+\.\d+\.\d+)\*\*/.exec(row);
      if (wave) {
        phase.waveIds = phase.waveIds || new Set();
        if (!phase.waveIds.has(wave[1])) {
          phase.waveIds.add(wave[1]);
          phase.waves += 1;
          const ownMark = /`\[([ x~])\]`/.exec(row);
          phase.waveList.push({
            id: wave[1],
            label: waveLabel(row, wave[1]),
            status: ownMark ? (STATUS[ownMark[1]] || STATUS[" "]) : null, // null = inherit
          });
        }
      }
    }
  }

  // Resolve inherited wave statuses now that every phase status is known.
  for (const entry of milestones) {
    for (const ph of entry.phases) {
      for (const w of ph.waveList) if (!w.status) w.status = ph.status;
    }
  }

  return milestones.filter((entry) => entry.phases.length > 0);
}

// Pull a short human label out of a wave row, whether it is a table row
// ("| **W0.2.1** | **Guardrail conflicts.** Run every ... |") or a bullet.
function waveLabel(row, id) {
  let text;
  if (row.startsWith("|")) {
    const cells = row.split("|").map((c) => c.trim()).filter((c, i, a) => !(i === 0 && c === "") && !(i === a.length - 1 && c === ""));
    text = cells.slice(1).join(" ");
  } else {
    text = row.replace(/^[-*]\s*/, "");
  }
  text = cleanTitle(text).replace(new RegExp(`^${id}\\b[\\s:.—-]*`), "").trim();
  // Prefer the leading bolded sentence ("Guardrail conflicts.") when present.
  const lead = /^([^.]{3,60})\./.exec(text);
  if (lead) return lead[1].trim();
  return text.length > 72 ? `${text.slice(0, 69).trimEnd()}…` : text;
}

function rollUp(milestones) {
  const phases = milestones.flatMap((entry) => entry.phases);
  const count = (key) => phases.filter((item) => item.status.key === key).length;
  for (const entry of milestones) {
    const total = entry.phases.length;
    const done = entry.phases.filter((item) => item.status.key === "done").length;
    const doing = entry.phases.filter((item) => item.status.key === "doing").length;
    entry.total = total;
    entry.done = done;
    entry.doing = doing;
    entry.pct = total ? Math.round((done / total) * 100) : 0;
    entry.status = done === total ? "done" : (done > 0 || doing > 0) ? "doing" : "todo";
    const entryWaves = entry.phases.flatMap((item) => item.waveList);
    entry.waveTotal = entryWaves.length;
    entry.waveDone = entryWaves.filter((w) => w.status.key === "done").length;
  }
  const allWaves = phases.flatMap((item) => item.waveList);
  const totalPhases = phases.length;
  const donePhases = count("done");
  return {
    totalPhases,
    donePhases,
    doingPhases: count("doing"),
    todoPhases: count("todo"),
    pct: totalPhases ? Math.round((donePhases / totalPhases) * 100) : 0,
    totalMilestones: milestones.length,
    doneMilestones: milestones.filter((entry) => entry.status === "done").length,
    totalWaves: phases.reduce((sum, item) => sum + item.waves, 0),
    doneWaves: allWaves.filter((w) => w.status.key === "done").length,
    totalDbChanges: milestones.reduce((sum, entry) => sum + entry.dbChanges.length, 0),
    // "You are here" = the first phase that is not finished.
    current: phases.find((item) => item.status.key === "doing")
      || phases.find((item) => item.status.key === "todo")
      || null
  };
}

function renderWaves(phase) {
  if (!phase.waveList.length) return "";
  const done = phase.waveList.filter((w) => w.status.key === "done").length;
  const rows = phase.waveList.map((w) => `
            <li class="wave ${w.status.key}">
              <span class="wtick" aria-hidden="true"></span>
              <span class="wid">${esc(w.id)}</span>
              <span class="wlabel">${esc(w.label)}</span>
            </li>`).join("");
  return `
        <li class="waveWrap">
          <ul class="waves-list" data-done="${done}" data-total="${phase.waveList.length}">${rows}
          </ul>
        </li>`;
}

function renderDbChanges(entry) {
  if (!entry.dbChanges.length) return "";
  const rows = entry.dbChanges.map((d, i) => {
    const exists = fs.existsSync(path.join(ROOT, d.file));
    return `
          <li class="dbrow">
            <span class="dbnum">${i + 1}</span>
            <code class="dbfile">${esc(d.file)}</code>
            <span class="dbbadge ${exists ? "ready" : "planned"}">${exists ? "ready to run" : "not written yet"}</span>
            ${d.note ? `<span class="dbnote">${esc(d.note)}</span>` : ""}
          </li>`;
  }).join("");
  return `
      <div class="dbblock">
        <div class="dbhead">🗄 Database changes for ${esc(entry.id)} — apply in this order</div>
        <ol class="dblist">${rows}
        </ol>
      </div>`;
}

function renderMilestone(entry) {
  const open = entry.status !== "done" ? " open" : "";
  const phaseRows = entry.phases.map((phase) => `
        <li class="phase ${phase.status.key}">
          <span class="tick" aria-hidden="true"></span>
          <span class="pid">${esc(phase.id)}</span>
          <span class="ptitle">${esc(phase.title)}</span>
          ${phase.waves ? `<span class="waves">${phase.waveList.filter((w) => w.status.key === "done").length}/${phase.waves} waves</span>` : ""}
          <span class="pstatus">${esc(phase.status.label)}</span>
        </li>${renderWaves(phase)}`).join("");

  const waveBadge = entry.waveTotal
    ? `<span class="mwaves">${entry.waveDone}/${entry.waveTotal}w</span>` : "";

  return `
    <details class="ms ${entry.status}"${open}>
      <summary>
        <span class="mid">${esc(entry.id)}</span>
        <span class="mtitle">${esc(entry.title)}</span>
        ${waveBadge}
        <span class="mcount">${entry.done}/${entry.total}</span>
        <span class="mbar"><i style="width:${entry.pct}%"></i></span>
        <span class="mpct">${entry.pct}%</span>
      </summary>
      ${entry.exit ? `<p class="exit"><strong>Exit criteria.</strong> ${esc(entry.exit)}</p>` : ""}
      <ul class="phases">${phaseRows}
      </ul>
      ${renderDbChanges(entry)}
    </details>`;
}

function render(milestones, totals, generatedAt) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>REFAL Brain — Plan Progress</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--card2:#1d212a;--line:#2b313d;--txt:#e6e9ef;
        --dim:#9aa4b2;--faint:#6b7483;--done:#3fb950;--doing:#d29922;--todo:#4b5565;--acc:#5b9cf8}
  @media (prefers-color-scheme: light){
    :root{--bg:#f6f7f9;--card:#fff;--card2:#f0f2f5;--line:#dde1e8;--txt:#1b1f27;
          --dim:#5a6472;--faint:#848d9b;--todo:#c2c9d4}
  }
  *{box-sizing:border-box}
  body{margin:0;padding:28px 18px 70px;background:var(--bg);color:var(--txt);
       font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:1040px;margin:0 auto}
  h1{font-size:26px;margin:0 0 4px;letter-spacing:-.4px}
  .sub{color:var(--dim);font-size:13.5px;margin:0 0 22px}
  .hero{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:18px}
  .heroTop{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
  .heroPct{font-size:46px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
  .heroLbl{color:var(--dim);font-size:13px;text-transform:uppercase;letter-spacing:.8px}
  .big{height:14px;border-radius:7px;background:var(--card2);overflow:hidden;margin:14px 0 4px;display:flex}
  .big i{display:block;height:100%}
  .big .d{background:var(--done)} .big .p{background:var(--doing)}
  .legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--dim);font-size:12.5px;margin-top:8px}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0 0}
  .tile{background:var(--card2);border-radius:10px;padding:13px 15px}
  .tile b{display:block;font-size:24px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.15}
  .tile span{color:var(--dim);font-size:11.5px;text-transform:uppercase;letter-spacing:.7px}
  .here{background:linear-gradient(135deg,rgba(91,156,248,.14),transparent);
        border:1px solid var(--acc);border-radius:12px;padding:15px 18px;margin:18px 0}
  .here .lbl{color:var(--acc);font-size:11.5px;text-transform:uppercase;letter-spacing:.9px;font-weight:700}
  .here .what{font-size:17px;font-weight:600;margin-top:3px}
  .ms{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:9px 0;overflow:hidden}
  .ms[open]{border-color:var(--acc)}
  .ms.done{opacity:.82}
  summary{display:flex;align-items:center;gap:12px;padding:13px 16px;cursor:pointer;list-style:none;user-select:none}
  summary::-webkit-details-marker{display:none}
  summary:hover{background:var(--card2)}
  .mid{font-weight:800;font-size:13px;min-width:34px;color:var(--acc)}
  .mtitle{flex:1;font-weight:600;font-size:14.5px}
  .mcount{color:var(--dim);font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
  .mbar{width:92px;height:7px;border-radius:4px;background:var(--card2);overflow:hidden;flex-shrink:0}
  .mbar i{display:block;height:100%;background:var(--done);border-radius:4px}
  .mpct{color:var(--dim);font-size:12px;min-width:34px;text-align:right;font-variant-numeric:tabular-nums}
  .exit{margin:0 16px 4px;padding:9px 12px;background:var(--card2);border-radius:8px;
        color:var(--dim);font-size:13px}
  .phases{list-style:none;margin:4px 0 12px;padding:0 16px}
  .phase{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:7px;font-size:13.5px}
  .phase:hover{background:var(--card2)}
  .tick{width:15px;height:15px;border-radius:50%;flex-shrink:0;border:2px solid var(--todo)}
  .phase.done .tick{background:var(--done);border-color:var(--done)}
  .phase.doing .tick{border-color:var(--doing);background:repeating-linear-gradient(45deg,var(--doing),var(--doing) 2px,transparent 2px,transparent 4px)}
  .pid{font-weight:700;font-size:12px;color:var(--faint);min-width:42px;font-variant-numeric:tabular-nums}
  .ptitle{flex:1}
  .phase.done .ptitle{color:var(--dim);text-decoration:line-through;text-decoration-color:var(--faint)}
  .waves{color:var(--faint);font-size:11.5px;white-space:nowrap}
  .pstatus{font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;
           padding:2px 8px;border-radius:12px;white-space:nowrap}
  .phase.done .pstatus{background:rgba(63,185,80,.16);color:var(--done)}
  .phase.doing .pstatus{background:rgba(210,153,34,.16);color:var(--doing)}
  .phase.todo .pstatus{background:var(--card2);color:var(--faint)}
  /* waves nested under a phase */
  .waveWrap{list-style:none;margin:0;padding:0}
  .waves-list{list-style:none;margin:1px 0 7px;padding:0 0 0 34px;
              border-left:2px solid var(--line);margin-left:17px}
  .wave{display:flex;align-items:center;gap:9px;padding:3px 8px;border-radius:5px;
        font-size:12.5px;color:var(--dim)}
  .wave:hover{background:var(--card2)}
  .wtick{width:9px;height:9px;border-radius:50%;flex-shrink:0;border:1.5px solid var(--todo)}
  .wave.done .wtick{background:var(--done);border-color:var(--done)}
  .wave.doing .wtick{border-color:var(--doing);background:var(--doing)}
  .wave.done .wlabel{text-decoration:line-through;text-decoration-color:var(--faint);opacity:.72}
  .wid{font-weight:700;font-size:11px;color:var(--faint);min-width:56px;font-variant-numeric:tabular-nums}
  .wlabel{flex:1}
  .mwaves{color:var(--faint);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
  /* database change block, end of each milestone */
  .dbblock{margin:6px 16px 14px;padding:12px 14px;background:var(--card2);
           border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:9px}
  .dbhead{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;
          color:var(--acc);margin-bottom:9px}
  .dblist{list-style:none;margin:0;padding:0;counter-reset:db}
  .dbrow{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:5px 0;font-size:12.5px}
  .dbrow + .dbrow{border-top:1px dashed var(--line)}
  .dbnum{width:19px;height:19px;border-radius:50%;background:var(--acc);color:#fff;
         font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .dbfile{font-size:11.5px}
  .dbbadge{font-size:10px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;
           padding:2px 7px;border-radius:10px;white-space:nowrap}
  .dbbadge.ready{background:rgba(63,185,80,.16);color:var(--done)}
  .dbbadge.planned{background:var(--card);color:var(--faint);border:1px solid var(--line)}
  .dbnote{flex:1 1 100%;color:var(--dim);font-size:12px;padding-left:28px}
  .ctl{display:flex;gap:10px;margin:16px 0 6px}
  button{background:var(--card2);color:var(--txt);border:1px solid var(--line);border-radius:8px;
         padding:7px 14px;font-size:13px;cursor:pointer;font-family:inherit}
  button:hover{border-color:var(--acc)}
  footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:var(--faint);font-size:12px}
  code{background:var(--card2);padding:2px 6px;border-radius:4px;font-size:12px;
       font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
</style>
</head>
<body><div class="wrap">

<h1>REFAL Brain — Plan Progress</h1>
<p class="sub">Generated from <code>.planning/REFAL-BRAIN-MASTER-PLAN.md</code>. The plan is the only source of truth, so this page can never drift from it.</p>

<div class="hero">
  <div class="heroTop">
    <span class="heroPct">${totals.pct}%</span>
    <span class="heroLbl">complete &nbsp;·&nbsp; ${totals.donePhases} of ${totals.totalPhases} phases</span>
  </div>
  <div class="big">
    <i class="d" style="width:${totals.totalPhases ? (totals.donePhases / totals.totalPhases) * 100 : 0}%"></i>
    <i class="p" style="width:${totals.totalPhases ? (totals.doingPhases / totals.totalPhases) * 100 : 0}%"></i>
  </div>
  <div class="legend">
    <span><i class="dot" style="background:var(--done)"></i>Done ${totals.donePhases}</span>
    <span><i class="dot" style="background:var(--doing)"></i>In progress ${totals.doingPhases}</span>
    <span><i class="dot" style="background:var(--todo)"></i>Not started ${totals.todoPhases}</span>
  </div>
  <div class="tiles">
    <div class="tile"><b>${totals.doneMilestones}/${totals.totalMilestones}</b><span>Milestones</span></div>
    <div class="tile"><b>${totals.donePhases}/${totals.totalPhases}</b><span>Phases</span></div>
    <div class="tile"><b>${totals.doneWaves}/${totals.totalWaves}</b><span>Waves done</span></div>
    <div class="tile"><b>${totals.totalDbChanges}</b><span>DB files to run</span></div>
  </div>
</div>

${totals.current ? `<div class="here">
  <div class="lbl">▶ You are here</div>
  <div class="what">${esc(totals.current.id)} — ${esc(totals.current.title)}</div>
</div>` : `<div class="here"><div class="lbl">✓ All phases complete</div></div>`}

<div class="ctl">
  <button onclick="document.querySelectorAll('.ms').forEach(d=>d.open=true)">Expand all</button>
  <button onclick="document.querySelectorAll('.ms').forEach(d=>d.open=false)">Collapse all</button>
</div>

${milestones.map(renderMilestone).join("")}

<footer>
  Generated ${esc(generatedAt)} · ${totals.totalMilestones} milestones · ${totals.totalPhases} phases · ${totals.totalWaves} waves<br>
  Regenerate after any plan update with <code>npm run plan:ui</code>, then refresh this page.<br>
  Status marks come straight from the plan: <code>[ ]</code> not started · <code>[~]</code> in progress · <code>[x]</code> done.
</footer>

</div></body></html>
`;
}

function main() {
  if (!fs.existsSync(PLAN)) {
    console.error(`Plan not found: ${PLAN}`);
    process.exit(1);
  }
  const milestones = parsePlan(fs.readFileSync(PLAN, "utf8"));
  if (!milestones.length) {
    console.error("No milestones parsed. Expected headings like '# M0 — Title' and '### P0.1 — Title `[ ]`'.");
    process.exit(1);
  }
  const totals = rollUp(milestones);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, render(milestones, totals, new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC"), "utf8");

  console.log(`Plan progress UI written to ${path.relative(ROOT, OUT)}`);
  console.log(`  ${totals.totalMilestones} milestones · ${totals.totalPhases} phases · ${totals.totalWaves} waves`);
  console.log(`  ${totals.donePhases} done · ${totals.doingPhases} in progress · ${totals.todoPhases} not started  (${totals.pct}%)`);
  if (totals.current) console.log(`  Next: ${totals.current.id} — ${totals.current.title}`);
}

if (require.main === module) main();

module.exports = { parsePlan, rollUp, cleanTitle };
