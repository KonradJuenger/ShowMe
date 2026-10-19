import { createServer } from 'vite';
import { _electron as electron } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const out = path.resolve('test-results-backdrop-root-cause');
await mkdir(out, { recursive: true });
const hit = (key, id = 'node') => `globalThis.__hit?.('${key}',${id});`;
const plugin = {
  name: 'temporary-backdrop-investigation', enforce: 'pre',
  transform(code, id) {
    const file = id.replaceAll('\\', '/').split('?')[0];
    const insert = (needle, extra) => { if (!code.includes(needle)) throw Error(`Missing ${needle} in ${file}`); code = code.replace(needle, needle + extra); };
    if (file.endsWith('/effectRuntime.ts')) {
      insert('const schedule = () => {', hit('schedule'));
      insert('const sourceChanged = () => {', hit('sourceChanged'));
      insert('const materialize = () => {', hit('materializeAttempt'));
      insert('const draw = () => {', hit('draw'));
      insert('const publish = () => {', hit('publish'));
      insert('setTiming(value) {', hit('setTiming'));
      code=code.replace('setTiming(value) {', `setTiming(value) { if(globalThis.__freezeShader && node.closest('[data-element-id]')?.dataset.elementId==='lower')return;`);
      code=code.replace('const publish = () => {', 'const publish = () => { if(globalThis.__noPublish)return;');
      insert('export async function flushEffectSurfaces(root: ParentNode) {', hit('flushAll', 'null'));
      insert('function flushScheduled() {', hit('flushScheduled', 'null'));
      insert('domRevision = shaderOutput.revision;', hit('materializeCopy'));
      insert('gl.drawArrays(gl.TRIANGLES, 0, 6);', hit('shaderDraw'));
    }
    if (file.endsWith('/cssBackdrop.ts')) {
      insert('async update(density: number) {', hit('backdropUpdate'));
      insert('const observer = new MutationObserver((records) => {', hit('backdropObserver'));
      code=code.replace('const observer = new MutationObserver((records) => {','const observer = new MutationObserver((records) => { if(globalThis.__noBackdropObserver)return;');
      insert('const changed = (event: Event) => {', hit('backdropEvent'));
      insert('if (!blocked && !material) {', hit('nativeFast'));
      insert('if (simple) {', hit('primitivePath'));
      insert('if (!raster) {', hit('nativeCreate'));
      insert('const compose = (', '');
      // Diagnostic-only switch, evaluated before any backdrop reconstruction.
      code = code.replace('const filter = getComputedStyle(node).backdropFilter;', 'if (globalThis.__disableReplay) { stopComposite(); replay.remove(); return; } const filter = getComputedStyle(node).backdropFilter;');
    }
    if (file.endsWith('/elementRaster.ts')) {
      insert('paintSource(canvas);', hit('primitivePaint', 'canvas'));
      code=code.replaceAll('const node = visualNode(element, context.root);', 'const node = visualNode(element, context.root); globalThis.__hit?.("primitiveElement",node);');
    }
    if (file.endsWith('/effectGraph.ts')) {
      insert('invalidate(key: Key) {',hit('graphInvalidate','key'));
      code=code.replace('if (node) node.dirty++;','if (node) {node.dirty++;globalThis.__hit?.("graphDirty",key);}');
      insert('await node.execute();',hit('graphExecute','key'));
    }
    if (file.endsWith('/motionRuntime.ts')) code=code.replace('opacity: appearance.opacity,','opacity: globalThis.__movementOnly ? element.appearance.opacity : appearance.opacity,');
    if (file.endsWith('/domRaster.ts')) {
      insert('metrics.captures++;', hit('capture', 'canvas'));
      insert('metrics.styleReads++;', hit('captureStyleRead', 'null'));
      insert('const markDirty = () => {', hit('domDirty', 'canvas'));
      insert('if (inFlight) return inFlight;', hit('domUpdate', 'canvas'));
    }
    return code;
  },
};
const server = await createServer({ plugins: [plugin], server: { host:'127.0.0.1', port: 5189, strictPort: true, watch: { ignored: ['**/test-results*/**', '**/.agenttmp/**'] } } });
await server.listen();
const main = path.resolve('.agenttmp/backdrop-diagnostic-main.cjs');
await mkdir(path.dirname(main), {recursive:true});
await writeFile(main, `const {app,BrowserWindow}=require('electron'); app.commandLine.appendSwitch('enable-blink-features','CanvasDrawElement'); app.whenReady().then(()=>{const w=new BrowserWindow({width:1040,height:720,webPreferences:{backgroundThrottling:false}});w.loadURL('http://127.0.0.1:5189/tests/helpers/effects-harness.html');});`);
let app;
try {
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 app = await electron.launch({ args: [main], env });
 const page = await app.firstWindow();
 page.on('pageerror', e => console.error('PAGE',e.message));
 console.log('ENV', await app.evaluate(async ({app}) => ({ versions:process.versions, gpu:await app.getGPUInfo('basic') })));
 const cases = process.env.PROBE_CASES ? JSON.parse(process.env.PROBE_CASES) : [
  ...['static','move','fade','moveFade','presence','presenceNoOpacity','wcTransform','wcOpacity'].map(mode => ({mode,n:1})),
  ...[3,10].flatMap(n=>['static','move','presence','presenceNoOpacity'].map(mode=>({mode,n}))),
  {mode:'presence',n:3,disableReplay:true}, {mode:'presence',n:3,freezeShader:true},
  {mode:'presence',n:3,noPublish:true}, {mode:'presence',n:3,noObserver:true},
  {mode:'rafMove',n:3}, {mode:'move',n:3,forceWC:true},
 ];
 const results=[];
 for (const cfg of cases) {
  await page.goto('http://127.0.0.1:5189/tests/helpers/effects-harness.html');
  await page.evaluate(async cfg => {
   globalThis.__disableReplay=cfg.disableReplay;globalThis.__movementOnly=cfg.mode==='presenceNoOpacity';
   globalThis.__probe={counts:{},frames:[],frame:0};
   globalThis.__hit=(key,node)=>{
    if(globalThis.__muteProbe) return;
    if(cfg.noPublish && key==='publish') return;
    const id=node?.closest?.('[data-element-id]')?.dataset.elementId??'all';
    const k=key+':'+id;
    const p=globalThis.__probe; p.counts[k]=(p.counts[k]??0)+1;
    const f=p.frames[p.frame]??={}; f[k]=(f[k]??0)+1;
   };
   const {mountMixedEffectsHarness}=await import('/tests/helpers/mixedEffectsHarness.tsx');
   const {createBasicShape}=await import('/src/core/elementFactory.ts');
   const {newEffectInstance}=await import('/src/core/effects.ts');
   const {blankEffect}=await import('/src/core/effectAuthoring.ts');
   const {createTextElement}=await import('/src/core/text.ts');
   const h=await mountMixedEffectsHarness(undefined,0,undefined,{configure(model){
    globalThis.__model=model;
    const s=model.slides[model.deck.slideIds[0]];
    model.deck.stylesheet=''; model.deck.width=960;model.deck.height=540;
    const shader={...blankEffect('shader'),input:'none',target:'background',source:'#version 300 es\nprecision highp float; uniform float u_t; in vec2 v_uv; out vec4 outColor; void main(){float s=step(0.5,fract(v_uv.x*60.+u_t));outColor=vec4(vec3(s),1.);}'};
    const css={...blankEffect('css-js'),source:':scope {backdrop-filter:blur(12px) saturate(1.25);background:linear-gradient(135deg,#ffffff66,#6699ff33);border-radius:18px;border:2px solid #ffffffaa;box-shadow:0 6px 12px #00224444;}'};
    s.effectResources={shader,css};
    const lower=createBasicShape('lower','rectangle',{x:0,y:0});lower.frame.width=960;lower.frame.height=540;lower.effects=[newEffectInstance('shader',shader,'background')];
    const cards=Array.from({length:cfg.n},(_,i)=>{
     const g=createBasicShape('glass'+i,'rectangle',{x:80+i*35,y:80+i*15});g.frame.width=300;g.frame.height=200;g.clipChildren=true;g.appearance.fill='#ffffff22';g.appearance.radius=18;g.effects=[newEffectInstance('css',css,'content')];
     if(cfg.text){const text=createTextElement('text'+i,{x:25,y:25});text.content.text='Glass card '+i;g.children=[text];}
     return g;
    });
    const lowerText=[];if(cfg.lowerText){const text=createTextElement('lowerText',{x:100,y:110});text.content.text='Native contributing text';lowerText.push(text);}
    s.nodes[0].children=[lower,...lowerText,...cards];
    const tracks=[];const blocks=[];
    cards.forEach((g,i)=>{
     if(['move','moveFade','wcTransform','wcOpacity'].includes(cfg.mode)) tracks.push({id:'x'+i,elementId:g.id,property:'transform.x',keyframes:[{id:'a'+i,at:0,value:{type:'absolute',value:g.frame.x-36},easeToNext:[0,0,1,1]},{id:'b'+i,at:1600,value:{type:'absolute',value:g.frame.x}}]});
     if(['fade','moveFade'].includes(cfg.mode)) tracks.push({id:'o'+i,elementId:g.id,property:'appearance.opacity',keyframes:[{id:'c'+i,at:0,value:{type:'absolute',value:0},easeToNext:[0,0,1,1]},{id:'d'+i,at:1600,value:{type:'absolute',value:1}}]});
     if(cfg.mode.startsWith('presence')) blocks.push({id:'p'+i,label:'Presence',members:[],binding:{kind:'presence',elementId:g.id},presenceSchedule:{version:1,startOffsetMs:0,end:{mode:'none'},enterTransition:{kind:'move',durationMs:1600,easing:[0,0,1,1],direction:'Up',distance:36},exitTransition:{kind:'none',durationMs:400,easing:[0,0,1,1]}}});
    });
    s.motion={stages:[{id:'step',tracks,blocks}]};
   }});
   globalThis.__h=h;
   globalThis.__runtimeModule=await import('/src/components/motionRuntime.ts');
   globalThis.__effects=await import('/src/components/effectRuntime.ts');
   globalThis.__freezeShader=cfg.freezeShader;globalThis.__noPublish=cfg.noPublish;globalThis.__noBackdropObserver=cfg.noObserver;
   globalThis.__ready=true;
  },cfg);
  await page.waitForTimeout(250);
  const traceName=[cfg.mode,cfg.n,...Object.keys(cfg).filter(k=>!['mode','n'].includes(k))].join('-');
  const tracing=process.env.PROBE_TRACE==='1';
  if(tracing) await app.evaluate(async ({contentTracing})=>contentTracing.startRecording({included_categories:['devtools.timeline','v8','blink','cc','gpu','viz','toplevel','disabled-by-default-devtools.timeline','disabled-by-default-v8.cpu_profiler']}));
  const result=await page.evaluate(async cfg=>{
   const p=globalThis.__probe;p.counts={};p.frames=[];p.frame=0;
   for(const method of ['compileShader','createTexture','texImage2D','readPixels']){
    const original=WebGL2RenderingContext.prototype[method];WebGL2RenderingContext.prototype[method]=function(...args){globalThis.__hit('gl_'+method,null);return original.apply(this,args);};
   }
   const originalGetImageData=CanvasRenderingContext2D.prototype.getImageData;
   CanvasRenderingContext2D.prototype.getImageData=function(...args){globalThis.__hit('getImageData',this.canvas);return originalGetImageData.apply(this,args);};
   for(const dimension of ['width','height']){
    const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,dimension);
    Object.defineProperty(HTMLCanvasElement.prototype,dimension,{...descriptor,set(value){if(descriptor.get.call(this)!==value)globalThis.__hit('canvasResize',this);descriptor.set.call(this,value);}});
   }
   const origGCS=globalThis.getComputedStyle;const nativeDraw=CanvasRenderingContext2D.prototype.drawImage;
   const times={gcs:0,drawImage:0};const num={gcs:0,drawImage:0};
   globalThis.getComputedStyle=function(...a){const t=performance.now();try{return origGCS(...a);}finally{times.gcs+=performance.now()-t;num.gcs++;}};
   CanvasRenderingContext2D.prototype.drawImage=function(...a){const t=performance.now();try{return nativeDraw.apply(this,a);}finally{times.drawImage+=performance.now()-t;num.drawImage++;}};
   const h=globalThis.__h;const slide=globalThis.__model.slides[globalThis.__model.deck.slideIds[0]];
   const rt=cfg.mode==='static'||cfg.mode==='rafMove'?null:globalThis.__runtimeModule.createMotionRuntime(h.host,slide,0);
   const cards=[...h.host.querySelectorAll('[data-element-id^="glass"]')];
   if(cfg.mode==='wcOpacity'||cfg.mode==='staticWC'||cfg.forceWC)cards.forEach(n=>n.style.willChange='transform, opacity');
   if(cfg.mode==='wcTransform')cards.forEach(n=>n.style.willChange='transform');
   const start=performance.now();const gaps=[];const gapTimes=[];let previous=start;const errors=[];let during;
   const baseline=globalThis.__effects;
   const surfaces=[...h.host.querySelectorAll('[data-effect-id]')];
   const startedAt=Date.now();
   rt?.sync({stageId:'step',stageIndex:0,time:0,startedAt,running:true});
   await new Promise(resolve=>{
    const tick=now=>{
     p.frame++;gaps.push(now-previous);previous=now;
     gapTimes.push(now-start);
     const t=(now-start)/1000;
     if(cfg.mode==='rafMove')cards.forEach(n=>n.style.transform=`translateX(${Math.min(1,t/1.6)*36-36}px)`);
     for(const node of surfaces){
      const isShader=node.closest('[data-element-id]')?.dataset.elementId==='lower';
      if(cfg.freezeShader&&isShader) continue;
      baseline.effectSurface(node)?.setTiming({time:t,duration:1.6,slideTime:t,presentationTime:t,stepTime:t,progress:1,running:true});
     }
     if(!during&&now-start>700) during=cards.map(n=>({opacity:n.style.opacity,willChange:n.style.willChange,transform:n.style.transform,backends:[...n.querySelectorAll('[data-css-backdrop]')].map(c=>c.dataset.cssBackdropBackend)}));
     if(now-start<2100)requestAnimationFrame(tick);else resolve();
    };requestAnimationFrame(tick);
   });
   const counts={...p.counts},frames=structuredClone(p.frames);
   const states=cards.map(n=>({opacity:n.style.opacity,willChange:n.style.willChange,transform:n.style.transform,backends:[...n.querySelectorAll('[data-css-backdrop]')].map(c=>c.dataset.cssBackdropBackend)}));
   const effects=[...h.host.querySelectorAll('[data-effect-error]')].map(n=>n.dataset.effectError);
   const q=a=>{a.sort((x,y)=>x-y);return {p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:a.at(-1),over33:a.filter(x=>x>33.34).length};};
   rt?.cancel();
   return {cfg,frames:frames.length,counts,perFrame:frames,states,during,effects,gaps:q([...gaps]),entrance:q(gaps.filter((_,i)=>gapTimes[i]<1600)),time:times,num};
  },cfg);
  if(tracing) await app.evaluate(async ({contentTracing},trace)=>contentTracing.stopRecording(trace),path.join(out,traceName+'.trace.json'));
  results.push(result);await writeFile(path.join(out,'matrix.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({...result,perFrame:undefined,states:result.states.slice(0,2)}));
 }
 if(process.env.PROBE_SEMANTICS==='1') {
  await page.evaluate(async()=>{globalThis.__disableReplay=true;globalThis.__muteProbe=true;await globalThis.__h.advance(.37);});
  const cdp=await app.context().newCDPSession(page);let layers=[];
  cdp.on('LayerTree.layerTreeDidChange',event=>{layers=event.layers??[];});
  await cdp.send('LayerTree.enable');
  const observations=[];
  for(const variant of ['native','parentTransform','parentWillTransform','parentWillOpacity','parentOpacity','effectOpacity']){
   await page.evaluate(variant=>{
    const card=document.querySelector('[data-element-id="glass0"]');const effect=card.querySelector('[data-effect-id]');
    card.style.transform=variant==='parentTransform'?'translateX(1px)':'none';
    card.style.opacity=variant==='parentOpacity'?'.5':'1';
    card.style.willChange=variant==='parentWillOpacity'?'transform, opacity':variant==='parentWillTransform'?'transform':'auto';
    effect.style.opacity=variant==='effectOpacity'?'.5':'1';
   },variant);
   await page.waitForTimeout(150);
   const png=await page.screenshot();await writeFile(path.join(out,variant+'.png'),png);
   const {data,info}=await sharp(png).extract({left:150,top:160,width:200,height:30}).removeAlpha().raw().toBuffer({resolveWithObject:true});
   const values=Array.from({length:200*30},(_,i)=>data[i*info.channels]);const mean=values.reduce((a,b)=>a+b)/values.length;
   const std=Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/values.length);
   const reasons=[];for(const layer of layers.filter(l=>l.drawsContent))try{reasons.push({layerId:layer.layerId,...await cdp.send('LayerTree.compositingReasons',{layerId:layer.layerId})});}catch{}
   observations.push({variant,redStd:std,redMean:mean,layerCount:layers.length,reasons});
  }
  await writeFile(path.join(out,'semantics.json'),JSON.stringify(observations,null,2));console.log('SEMANTICS',JSON.stringify(observations));
  // Compare actual pixels to a fade of the fully resolved group, including
  // overlapping foreground children, for the two DOM hierarchies.
  const parity=[];
  for(const hierarchy of ['descendant-filter','owner-filter']){
   await page.evaluate(hierarchy=>{
    const card=document.querySelector('[data-element-id="glass0"]');const effect=card.querySelector('[data-effect-id]');
    card.style.willChange='auto';card.style.transform='none';card.style.opacity='1';effect.style.opacity='1';
    if(hierarchy==='owner-filter'){
     card.style.backdropFilter='blur(12px) saturate(1.25)';effect.style.setProperty('backdrop-filter','none','important');
    }
    if(!card.querySelector('[data-probe-child]'))for(const [left,top,color] of [[25,25,'#ff000088'],[75,55,'#00ff0088']]){
     const child=document.createElement('div');child.dataset.probeChild='1';child.style.cssText=`position:absolute;left:${left}px;top:${top}px;width:120px;height:80px;background:${color}`;effect.append(child);
    }
   },hierarchy);
   const snap=async()=>{await page.waitForTimeout(100);return sharp(await page.screenshot()).extract({left:120,top:120,width:200,height:140}).removeAlpha().raw().toBuffer();};
   const full=await snap();await page.evaluate(()=>document.querySelector('[data-element-id="glass0"]').style.visibility='hidden');
   const back=await snap();await page.evaluate(()=>{const n=document.querySelector('[data-element-id="glass0"]');n.style.visibility='';n.style.opacity='.5';});
   const faded=await snap();let mse=0,max=0;for(let i=0;i<full.length;i++){const e=Math.abs(faded[i]-(full[i]*.5+back[i]*.5));mse+=e*e;max=Math.max(max,e);}
   parity.push({hierarchy,rmse:Math.sqrt(mse/full.length),max});
  }
  await writeFile(path.join(out,'hierarchy-parity.json'),JSON.stringify(parity,null,2));console.log('PARITY',parity);
 }
 const environment={electron:await app.evaluate(async({app})=>({versions:process.versions,status:app.getGPUFeatureStatus(),info:await app.getGPUInfo('complete')})),renderer:await page.evaluate(()=>({dpr:devicePixelRatio,width:innerWidth,height:innerHeight,ua:navigator.userAgent}))};
 await writeFile(path.join(out,'environment.json'),JSON.stringify(environment,null,2));console.log('GPU_FINAL',environment);
} finally {await app?.close();await server.close();}
