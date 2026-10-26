import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

/** Local append-only measurements survive report cleanup and branch switches. */
export async function recordAudienceBenchmark(report, directory) {
  await mkdir(directory, { recursive: true });
  const idPath = path.join(directory, "machine-id");
  let machineId;
  try {
    machineId = (await readFile(idPath, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    machineId = randomUUID();
    await writeFile(idPath, machineId, { flag: "wx" });
  }
  const group = createHash("sha256")
    .update(
      JSON.stringify({
        schema: report.schemaVersion,
        machineId,
        workload: report.workload,
        environment: report.environment,
        runs: report.runs,
      }),
    )
    .digest("hex");
  const record = { ...report, measurementId: randomUUID(), machineId, group };
  await appendFile(
    path.join(directory, "history.jsonl"),
    JSON.stringify(record) + "\n",
  );
  await renderAudienceHistory(directory);
  return record;
}

export async function renderAudienceHistory(directory) {
  const records = (
    await readFile(path.join(directory, "history.jsonl"), "utf8")
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const data = JSON.stringify(records).replaceAll("<", "\\u003c");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>ShowMe audience rendering history</title>
<style>body{font:15px system-ui;margin:32px;color:#172033;background:#f7f9fc}h1{font-size:24px}select{padding:8px;margin:8px}svg{background:white;border:1px solid #ccd4e0;width:100%;max-width:1100px}table{border-collapse:collapse;background:white;width:100%;max-width:1100px}th,td{padding:10px;text-align:left;border-bottom:1px solid #e2e6ed}small{color:#526078}a{color:#175ab1}#note{margin:16px 0}label{margin-right:16px}</style>
<h1>Audience rendering history</h1><p>Costs over measured revisions. Lower values mean less work or delay. Compare within one machine, workload, browser and output profile.</p>
<label>Series <select id="series"></select></label><label>Metric <select id="metric"></select></label>
<label><input type="checkbox" id="dirty"> Include exploratory dirty working trees</label>
<div id="note"></div><svg id="chart" viewBox="0 0 1100 340" role="img" aria-label="Performance cost over measured revisions"></svg>
<table><thead><tr><th>Measured revision</th><th>Time</th><th>Cost</th><th>Change from previous sample</th><th>Repeated-run range</th></tr></thead><tbody id="rows"></tbody></table>
<p><small>Gaps mean a commit was not measured. Lines connect observations, not estimates for missing commits. Branches and dirty samples may not follow main ancestry. Timing includes browser scheduling and instrumentation. Heap is retained JS memory after GC, not process/GPU memory.</small></p>
<script>
const records=${data};
const series=document.getElementById('series'),metric=document.getElementById('metric'),dirty=document.getElementById('dirty'),chart=document.getElementById('chart'),rows=document.getElementById('rows');
const groups=[...new Set(records.map(r=>r.group))];
for(const group of groups){const r=records.find(r=>r.group===group);const option=document.createElement('option');option.value=group;option.textContent=r.environment.cpu+' · '+r.environment.width+'×'+r.environment.height+' @'+r.environment.dpr+' · workload '+r.workload.version+' · '+r.runs+' runs · '+group.slice(0,8);series.append(option)}
for(const key of Object.keys(records.at(-1)?.metrics??{})){const option=document.createElement('option');option.value=key;option.textContent=key;metric.append(option)}
const svg=(tag,attributes,text)=>{const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value]of Object.entries(attributes))node.setAttribute(key,value);if(text!==undefined)node.textContent=text;return node};
function draw(){const samples=records.filter(r=>r.group===series.value&&(dirty.checked||!r.dirty)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));const key=metric.value;chart.replaceChildren();rows.replaceChildren();document.getElementById('note').textContent=samples.length+' observations; '+(dirty.checked?'dirty runs are labeled and are not results for their parent commit.':'clean committed revisions only. Enable exploratory samples to inspect uncommitted work.');if(!samples.length)return;
const maximum=Math.max(...samples.map(r=>r.metrics[key]),1)*1.1;const x=i=>70+i*950/Math.max(samples.length-1,1),y=v=>280-v/maximum*240;
for(let i=0;i<=4;i++){const value=maximum*i/4;chart.append(svg('line',{x1:70,y1:y(value),x2:1020,y2:y(value),stroke:'#e2e6ed'}),svg('text',{x:5,y:y(value)+5,'font-size':12},value.toFixed(1)))}
chart.append(svg('polyline',{points:samples.map((r,i)=>x(i)+','+y(r.metrics[key])).join(' '),fill:'none',stroke:'#2165ba','stroke-width':2}));
samples.forEach((r,i)=>{const label=r.revision.slice(0,8)+(r.dirty?'+dirty':'');const point=svg('circle',{cx:x(i),cy:y(r.metrics[key]),r:5,fill:r.dirty?'#d56a20':'#2165ba'});point.append(svg('title',{},label+' · '+r.metrics[key]+' · '+r.createdAt));chart.append(point);if(samples.length<=16||i===0||i===samples.length-1)chart.append(svg('text',{x:x(i),y:305,'text-anchor':'middle','font-size':11},label));const tr=document.createElement('tr');const previous=samples[i-1]?.metrics[key];const change=previous?100*(r.metrics[key]-previous)/previous:null;const range=r.metricRanges?.[key];for(const text of [label+' · '+(r.branch??''),r.createdAt,r.metrics[key].toFixed(2),change===null?'—':(change>0?'+':'')+change.toFixed(1)+'%',range?range.min.toFixed(2)+' – '+range.max.toFixed(2):'—']){const td=document.createElement('td');td.textContent=text;tr.append(td)}rows.append(tr)});
}
series.value=groups.at(-1)??'';series.onchange=metric.onchange=dirty.onchange=draw;draw();
</script></html>`;
  await writeFile(path.join(directory, "history.html"), html);
  return records;
}
