import {readFile,writeFile} from 'node:fs/promises';
const prefix=process.argv[2]??'test-results-glass-final-lowpass/warm-repeat';
const events=JSON.parse(await readFile(prefix+'.trace.json','utf8')).traceEvents;
const summary=JSON.parse(await readFile('test-results-glass-final-lowpass/summary.json','utf8')).find(x=>prefix.endsWith(x.mode));
const marks=events.filter(e=>e.name==='ShowMe:motion-sync'&&e.ph==='b');
const marker=marks.find(e=>{try{return (!summary||e.pid===summary.audienceProcess.pid)&&JSON.parse(e.args?.detail??'{}').running}catch{return false}});
const renderer=events.find(e=>e.name==='thread_name'&&e.args?.name==='CrRendererMain');
const pid=marker?.pid??summary?.audienceProcess.pid??renderer?.pid;
const tid=marker?.tid??summary?.audienceProcess.mainThreadId??renderer?.tid;
const start=marker?.ts??events.reduce((m,e)=>e.ph==='X'?Math.min(m,e.ts):m,Infinity);
const duration=summary?.duration??1600;
const main=events.filter(e=>e.pid===pid&&e.tid===tid&&e.ph==='X'&&e.dur).sort((a,b)=>a.ts-b.ts||b.dur-a.dur);
const stats=(list)=>{
 const sums={};const last={};
 for(const e of list){if((last[e.name]??0)>e.ts)continue;last[e.name]=e.ts+e.dur;const x=sums[e.name]??={count:0,totalMs:0,maxMs:0};x.count++;x.totalMs+=e.dur/1000;x.maxMs=Math.max(x.maxMs,e.dur/1000);}
 return Object.entries(sums).sort((a,b)=>b[1].totalMs-a[1].totalMs);
};
const entrance=main.filter(e=>e.ts>=start&&e.ts<start+duration*1000);
const steady=main.filter(e=>e.ts>=start+duration*1000&&e.ts<start+(duration+3000)*1000);
const largest=entrance.filter(e=>e.name==='Paint').sort((a,b)=>b.dur-a.dur).slice(0,4).map(e=>({event:e,children:stats(main.filter(x=>x!==e&&x.ts>=e.ts&&x.ts+x.dur<=e.ts+e.dur)).slice(0,22)}));
const output={prefix,marker,pid,tid,start,duration,entrance:stats(entrance),steady:stats(steady),largest};
await writeFile(prefix+'.analysis.json',JSON.stringify(output,null,2));
console.log(JSON.stringify({...output,entrance:output.entrance.slice(0,35),steady:output.steady.slice(0,12)},null,2));
