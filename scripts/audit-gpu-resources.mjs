// Research-only: builds isolated snapshots; never checks out or changes main.
import {build} from "vite";
import {chromium} from "playwright";
import electron from "electron";
import {execFileSync, spawn} from "node:child_process";
import {mkdir,readFile,writeFile,cp,access} from "node:fs/promises";
import {createServer} from "node:http";
import {resolve,extname,sep} from "node:path";
import {createHash} from "node:crypto";
import os from "node:os";
import {installResourceProbe} from "./gpu-resource-probe.mjs";
const base=resolve(".agenttmp/gpu-resource-audit"), duration=10000;
await mkdir(base,{recursive:true});
const git=(...args)=>execFileSync("git",args,{encoding:"utf8"}).trim();
const refs={gpu:git("rev-parse","HEAD"),native:git("rev-parse","main"),shared:git("rev-parse","research/native-gpu-shared-texture-boundary")};
const archive=async(ref,name)=>{
  const target=resolve(base,name); await mkdir(target,{recursive:true});
  execFileSync("tar",["-xf","-","-C",target],{input:execFileSync("git",["archive",ref],{maxBuffer:100*1024*1024})});
  return target;
};
const mainRoot=await archive(refs.native,"main-snapshot");
const sharedRoot=await archive(refs.shared,"shared-snapshot");
for(const name of ["gpuRendererHarness.tsx","gpuNativeTextRaster.ts","gpuResourceAudit.tsx","gpu-resource-audit.html"])
  await cp(resolve("tests/helpers",name),resolve(mainRoot,"tests/helpers",name));
await cp(resolve("src/experiments/gpu-renderer"),resolve(mainRoot,"src/experiments/gpu-renderer"),{recursive:true});
for(const [root,name] of [[process.cwd(),"gpu"],[mainRoot,"native"]])
  await build({root,logLevel:"warn",build:{outDir:resolve(base,`${name}-dist`),rollupOptions:{input:resolve(root,"tests/helpers/gpu-resource-audit.html")}}});

// Only the local shared snapshot is altered: stop its source/CSS animation for
// the static control. The bounded managed transport itself is left unchanged.
const sharedDir=resolve(sharedRoot,"experiments/native-gpu-shared-texture");
const scene=await readFile(resolve(sharedDir,"scene.js"),"utf8");
await writeFile(resolve(sharedDir,"scene.js"),scene.replaceAll("requestAnimationFrame(frame);","if (!globalThis.__RESOURCE_STATIC || !canvas.dataset.once) {canvas.dataset.once='1';requestAnimationFrame(frame);}"));
const sharedHtml=await readFile(resolve(sharedDir,"scene.html"),"utf8");
const sharedMain=await readFile(resolve(sharedDir,"main.cjs"),"utf8");
await writeFile(resolve(sharedDir,"main.cjs"),sharedMain.replace('show,\n    backgroundColor:', 'show,\n    frame: false, fullscreen: true,\n    backgroundColor:'));

const evidence={schemaVersion:1,recordedAt:new Date().toISOString(),refs,dirty:git("status","--porcelain"),
  host:{os:os.release(),cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,node:process.version},
  methodology:"10s, 3s warmup, two serial rounds in reversed order; counter sampler is the only concurrent monitoring process; common ShowMe fixture for gpu/main; shared fixture is intentionally different",files:{},runs:[]};
for(const file of ["scripts/audit-gpu-resources.mjs","scripts/gpu-resource-probe.mjs","scripts/gpu-resource-counters.ps1","tests/helpers/gpuResourceAudit.tsx","tests/helpers/gpuRendererHarness.tsx","src/experiments/gpu-renderer/renderer.ts"])
  evidence.files[file]=createHash("sha256").update(await readFile(file)).digest("hex");
const save=()=>writeFile(resolve(base,"evidence.json"),JSON.stringify(evidence,null,2));
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const port=async()=>{const s=createServer();await new Promise(r=>s.listen(0,"127.0.0.1",r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const startCounters=async(label,samples=12)=>{
  const output=resolve(base,`${label}-pdh.json`), ready=resolve(base,`${label}-ready-${Date.now()}`);
  const proc=spawn("powershell.exe",["-NoProfile","-File",resolve("scripts/gpu-resource-counters.ps1"),"-OutputPath",output,"-ReadyPath",ready,"-Samples",String(samples)],{windowsHide:true,stdio:"ignore"});
  const ended=new Promise(r=>proc.once("exit",r));
  for(let i=0;i<200;i++){try{await access(ready);break;}catch{await sleep(100);}}
  return async()=>{await ended;return JSON.parse(await readFile(output,"utf8"));};
};
const connect=async(p)=>{for(let i=0;i<100;i++){try{return await chromium.connectOverCDP(`http://127.0.0.1:${p}`,{timeout:1000});}catch{await sleep(100);}}throw Error("CDP failed");};
const processSnapshot=async(browser)=>{
  const cdp=await browser.newBrowserCDPSession();const info=await cdp.send("SystemInfo.getProcessInfo");await cdp.detach();
  const ids=info.processInfo.map(p=>Number(p.id));
  const memory=JSON.parse(execFileSync("powershell.exe",["-NoProfile","-Command",`Get-Process -Id ${ids.join(",")} | Select-Object Id,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`],{encoding:"utf8",windowsHide:true}));
  return {epochMs:Date.now(),...info,memory};
};
const gpuInfo=async(browser)=>{const s=await browser.newBrowserCDPSession();const result={version:await s.send("Browser.getVersion"),info:await s.send("SystemInfo.getInfo")};await s.detach();return result;};
const filterCounters=(samples,ids)=>Array.isArray(samples)?samples.map(s=>({...s,counters:s.counters.filter(c=>ids.some(id=>c.instance.startsWith(`pid_${id}_`)))})):samples;

async function runPage(kind,variant,label){
  const dist=resolve(base,`${kind}-dist`);
  const server=createServer(async(req,res)=>{const path=resolve(dist,`.${new URL(req.url,"http://localhost").pathname}`);if(!path.startsWith(dist+sep)){res.writeHead(403).end();return;}try{res.setHeader("Content-Type",{".html":"text/html",".js":"text/javascript",".css":"text/css"}[extname(path)]??"application/octet-stream");res.end(await readFile(path));}catch{res.writeHead(404).end();}});
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const url=`http://127.0.0.1:${server.address().port}/tests/helpers/gpu-resource-audit.html?kind=${kind}&variant=${variant}`;
  const main=resolve(base,`${label}.cjs`), debug=await port();
  await writeFile(main,`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(resolve(base,`${label}-profile`))});app.commandLine.appendSwitch('force-device-scale-factor','1.604166666666667');app.commandLine.appendSwitch('enable-blink-features','CanvasDrawElement');app.whenReady().then(()=>{const w=new BrowserWindow({width:1596,height:998,frame:false,fullscreen:true,show:true,webPreferences:{backgroundThrottling:false}});w.loadURL(${JSON.stringify(url)});});app.on('window-all-closed',()=>app.quit());`);
  const child=spawn(electron,[`--remote-debugging-port=${debug}`,"--force_low_power_gpu",main],{env,windowsHide:true,stdio:"ignore"});
  let browser;
  try{
    browser=await connect(debug);const page=browser.contexts()[0].pages()[0];
    await page.addInitScript(installResourceProbe);await page.reload();
    const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.waitForFunction(()=>window.resourceAudit,undefined,{timeout:30000});
    const probe=await page.evaluate(()=>window.resourceAudit.inspectFrame());
    await page.evaluate(()=>window.resourceAudit.sample(3000));
    const finishCounters=await startCounters(label);
    const before=await processSnapshot(browser);
    const webBefore=await page.evaluate(()=>window.resourceProbe());
    const startEpochMs=Date.now();
    const sample=await page.evaluate(duration=>window.resourceAudit.sample(duration),duration);
    const endEpochMs=Date.now();
    const webAfter=await page.evaluate(()=>window.resourceProbe());
    const after=await processSnapshot(browser);
    const result={kind,variant,label,startEpochMs,endEpochMs,before,after,webBefore,webAfter,sample,probe,errors,
      viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})),gpu:await gpuInfo(browser)};
    result.counters=filterCounters(await finishCounters(),before.processInfo.map(p=>p.id));
    return result;
  }finally{if(browser)await browser.close();child.kill();server.close();}
}

async function runShared(variant,label){
  await writeFile(resolve(sharedDir,"scene.html"),variant==="static"?sharedHtml.replace("</head>","<style>* {animation:none !important;transition:none !important}</style><script>globalThis.__RESOURCE_STATIC=true;</script></head>"):sharedHtml);
  const debug=await port(), output=resolve(base,`${label}-shared.json`);
  const finishCounters=await startCounters(label,20);
  const child=spawn(electron,[`--remote-debugging-port=${debug}`,resolve(sharedDir,"main.cjs"),"--force_low_power_gpu","--show","--backend=webgpu","--benchmark",`--duration=${duration}`,"--warmup=3000","--width=1596","--height=998","--dpr=1.604166666666667","--fps=60",`--output=${output}`],{env,windowsHide:true,stdio:"ignore"});
  const ended=new Promise(r=>child.once("exit",r));
  let browser,processes;
  try{
    browser=await connect(debug);
    await sleep(1000);processes=await processSnapshot(browser);
    const gpu=await gpuInfo(browser);
    const code=await ended;
    const result={kind:"shared",variant,label,code,gpu,processes,result:JSON.parse(await readFile(output,"utf8"))};
    result.counters=filterCounters(await finishCounters(),processes.processInfo.map(p=>p.id));
    return result;
  }finally{if(browser)await browser.close().catch(()=>{});child.kill();}
}

const configs=[["gpu","animated"],["native","animated"],["shared","animated"],
  ["gpu","static"],["native","static"],["shared","static"],
  ["gpu","frozen"],["native","frozen"],["gpu","upper-motion"],
  ["gpu","parked"],["gpu","frozen-parked"]];
const only=process.argv.find(a=>a.startsWith("--only="))?.slice(7);
for(let round=0;round<(only?1:2);round++){
  for(const [kind,variant] of (round?[...configs].reverse():configs).filter(([k,v])=>!only||`${k}-${v}`===only)){
    const label=`${round+1}-${kind}-${variant}`;console.log(`Sampling ${label}`);
    const result=kind==="shared"?await runShared(variant,label):await runPage(kind,variant,label);
    evidence.runs.push(result);await save();
    console.log(JSON.stringify({label,errors:result.errors,frames:result.sample?.renders,shared:result.result?.source?.paintEventsPerSec}));
  }
}
console.log(`Evidence: ${base}/evidence.json`);
