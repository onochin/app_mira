/* Checks local parsing, gap-aware numerical output, and renderer control flow.
 * Browser/GPU pixels and file-picker interaction are not simulated as verified.
 * Run: node tools/check_folder_reader.cjs [--all-data]
 */
"use strict";
const fs=require("node:fs"),fsp=require("node:fs/promises"),path=require("node:path"),vm=require("node:vm"),assert=require("node:assert/strict");
const root=path.resolve(__dirname,"..");
const source={window:{}};vm.createContext(source);
vm.runInContext(fs.readFileSync(path.join(root,"folder_reader/palette.js"),"utf8"),source);
vm.runInContext(fs.readFileSync(path.join(root,"folder_reader/parser.js"),"utf8"),source);
const api=source.window.MiraFolderData;

function file(p){
  return {name:path.basename(p),webkitRelativePath:path.relative(root,p).split(path.sep).join("/"),
    text:()=>fsp.readFile(p,"utf8"),arrayBuffer:async()=>{const b=await fsp.readFile(p);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);}};
}
async function filesIn(directory){
  const result=[];
  for(const item of await fsp.readdir(directory,{withFileTypes:true})){
    const p=path.join(directory,item.name);
    if(item.isDirectory())result.push(...await filesIn(p));
    else if(/\.(cfg|bin|bmp)$/i.test(item.name))result.push(file(p));
  }
  return result;
}

function renderer(meta,values){
  const elements=new Map(),uniforms=new Map(),errors=[],staticUploads=[],frames=[],events={},messages=[];
  let frame;
  const gl=new Proxy({
    createShader:()=>({}),createProgram:()=>({}),createTexture:()=>({}),createVertexArray:()=>({}),createBuffer:()=>({}),
    getShaderParameter:()=>true,getProgramParameter:()=>true,getParameter:()=>256,getError:()=>0,getUniformLocation:(_,name)=>name,
    uniform1f:(name,value)=>uniforms.set(name,value),uniformMatrix4fv:(name,_,value)=>uniforms.set(name,Array.from(value)),
    bufferData:(_,data,usage)=>{if(usage==="STATIC_DRAW")staticUploads.push(Array.from(data));},
    clear:()=>{frame=[];frames.push(frame);},drawArrays:(type,start,count)=>{if(type==="TRIANGLES")frame.push({start,count});},
  },{get:(target,key)=>key in target?target[key]:typeof key==="string"&&key===key.toUpperCase()?key:()=>{}});
  function element(id){
    if(elements.has(id))return elements.get(id);
    const ctx=new Proxy({createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}),putImageData:image=>{ctx.image=image;}},
      {get:(target,key)=>key in target?target[key]:()=>{}});
    const e={id,width:296,height:432,value:"0",events:{},dataset:{},style:{},context:ctx,classList:{add:()=>{}},
      getBoundingClientRect:()=>({left:0,top:0,width:id==="section"?340:1000,height:id==="projection"?171:445}),
      getContext:type=>type==="webgl2"?gl:ctx,addEventListener:(type,fn)=>{e.events[type]=fn;},
      setAttribute:()=>{},removeAttribute:()=>{},focus:()=>{},setPointerCapture:()=>{},hasPointerCapture:()=>false,releasePointerCapture:()=>{}};
    elements.set(id,e);return e;
  }
  const buttons=["oblique","front","top","side"].map(name=>{const b=element(name);b.dataset.view=name;return b;});
  let canvasCount=0;const parent={postMessage:data=>messages.push(data)};
  const sandbox={Uint8Array,Float32Array,Math,Array,Number,String,devicePixelRatio:1,MiraFolderData:api,parent,
    URL:{createObjectURL:()=>"blob:test",revokeObjectURL:()=>{}},
    document:{getElementById:element,createElement:()=>element(`offscreen-${canvasCount++}`),querySelectorAll:()=>buttons,body:element("body")},
    console:{error:error=>errors.push(String(error))},ResizeObserver:class{observe(){}},requestAnimationFrame:fn=>fn(),
    addEventListener:(type,fn)=>{events[type]=fn;}};sandbox.window=sandbox;
  vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(root,"folder_reader/viewer.js"),"utf8"),sandbox);
  assert.equal(messages[0].type,"mira-ready");
  // A different sender must not initialise the frame.
  events.message({source:{},data:{type:"mira-data"}});assert.equal(frames.length,0);
  events.message({source:parent,data:{type:"mira-data",meta,buffer:values.buffer,originalFiles:Array(meta.count).fill(null)}});
  assert.equal(errors.length,0,errors.join("\n"));
  return {element,uniforms,errors,staticUploads,frames,messages,projection:()=>element("offscreen-1").context.image,
    toggle:on=>element("interpolate").events.change({target:{checked:on}})};
}

async function loaderControls(inputFiles){
  const elements=new Map(),events={},sent=[];
  function element(id){
    if(elements.has(id))return elements.get(id);
    const e={id,value:"",files:[],events:{},children:[],style:{},classList:{toggle:()=>{}},textContent:"",
      addEventListener:(name,fn)=>{e.events[name]=fn;},replaceChildren:(...children)=>{e.children=children;},
      append:child=>e.children.push(child),click:()=>{},reportValidity:()=>true};
    if(id.startsWith("iframe"))e.contentWindow={postMessage:(data,origin,transfer)=>sent.push({data,origin,transfer})};
    elements.set(id,e);return e;
  }
  let count=0;
  const sandbox={MiraFolderData:api,Number,Math,console,
    document:{getElementById:element,createElement:type=>element(`${type}-${count++}`)},
    addEventListener:(name,fn)=>{events[name]=fn;}};sandbox.window=sandbox;
  vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(root,"folder_reader/loader.js"),"utf8"),sandbox);
  element("folder").files=inputFiles;element("folder").events.change();
  assert.equal(element("first").value,30);assert.equal(element("last").value,101);
  element("stepMm").value="100";
  await element("loadForm").events.submit({preventDefault(){}});
  const frame=element("viewerHost").children[0];assert(frame&&frame.src==="folder_reader/viewer.html");
  events.message({source:{},data:{type:"mira-ready"}});assert.equal(sent.length,0);
  events.message({source:frame.contentWindow,data:{type:"mira-ready"}});
  assert.equal(sent.length,1);assert.equal(sent[0].data.meta.missingCount,70);
  assert.deepEqual(Array.from(sent[0].data.meta.positionsMm),[0,7100]);assert.equal(sent[0].transfer.length,1);
  events.message({source:frame.contentWindow,data:{type:"mira-ready"}});assert.equal(sent.length,1);
  events.message({source:frame.contentWindow,data:{type:"mira-rendered",count:2,missingCount:70,verifiedImages:2}});
  assert(element("status").textContent.includes("欠番70"));
  assert.equal(element("load").disabled,false);
  console.log("PASS: folder/series/range controls; two-record 70-slot gap; pinned iframe handshake; single buffer transfer; displayed status.");
}

async function main(){
  const bin=new ArrayBuffer(16),binView=new DataView(bin);[1,2,3,4].forEach((v,i)=>binView.setInt32(i*4,v,true));
  assert.deepEqual(Array.from(api.decodeBin(bin,2,2)),[2,1,4,3]);
  assert.throws(()=>api.decodeBin(new ArrayBuffer(15),2,2));binView.setInt32(0,255,true);assert.throws(()=>api.decodeBin(bin,2,2));
  const meta={folder:"fixture",series:"u",prefix:"u",width:2,height:1,count:3,firstNumber:1,lastNumber:5,slotCount:5,
    numbers:[1,2,5],positionsMm:[0,100,400],names:["u1","u2","u5"],stepMm:100,lengthMm:400,
    heightMinMm:-257,heightSpanMm:514,depthMm:750,palette:Array.from({length:255},(_,i)=>[i,i,i]),
    verifiedImages:0,verifiedPixels:0,missingCount:2,incomplete:[]};
  const values=new Uint8Array([200,0,0,200,80,80]);
  const plan=api.makePlan(meta,10);assert.equal(plan.length,12);assert.equal(plan.at(-1).weight,1);
  assert.equal(plan[0].weight,2/11);assert(!plan.some(p=>p.x>100&&p.x<400));
  const projection=api.buildProjection(meta,values,10);
  assert.deepEqual(Array.from(projection.values.slice(0,11)),[200,180,160,140,120,100,120,140,160,180,200]);
  for(let x=11;x<40;x++)assert(Number.isNaN(projection.values[x]),"no interpolation across missing numbers");
  assert.equal(projection.values[40],80);
  const app=renderer(meta,values);assert.equal(app.frames.at(-1).length,3);
  assert.deepEqual([0,1,2,3,4].map(x=>app.projection().data[x*4+3]),[255,255,0,0,255]);
  app.toggle(true);assert.equal(app.frames.at(-1).length,12);assert.equal(app.projection().data[20*4+3],0);
  const actualX=app.staticUploads[0].filter((_,i)=>i%42===0);assert.deepEqual(actualX,[-200,-100,200]);
  const syntheticX=app.staticUploads[1].filter((_,i)=>i%42===0);assert(!syntheticX.some(x=>x>-100&&x<200));
  const previous=app.element("scanValue").textContent;
  app.element("projection").events.click({currentTarget:app.element("projection"),clientX:42+2.5/5*935});
  assert.equal(app.element("scanValue").textContent,previous);assert(app.element("renderStatus").textContent.includes("データなし"));
  app.element("scan").events.input({target:{value:"2"}});assert.equal(app.element("scanValue").textContent,"u5 · 400 mm");
  app.toggle(false);assert.equal(app.frames.at(-1).length,3);assert.equal(app.errors.length,0);
  console.log("PASS: little-endian decoding; numerical interpolation; empty missing slots; no geometry across gaps; isolated-plane opacity; missing-slot selection.");

  const cFiles=await filesIn(path.join(root,"261113")),cGroup=api.discover(cFiles).groups[0];
  const exampleFiles=[];
  for(const number of [30,101])for(const ext of ["cfg","bin","bmp"]){
    const original=cFiles.find(f=>f.name===`W10_A-B_MI_vW9_c1.${ext}`);
    exampleFiles.push({...original,name:`example_u${number}.${ext}`,webkitRelativePath:`fixture/example_u${number}.${ext}`});
  }
  await loaderControls(exampleFiles);
  const c=await api.readDataset(cGroup,1,45,100);
  const text=fs.readFileSync(path.join(root,"archive/prototype/data.js"),"utf8"),match=/window\.MIRA_BASE64 = "([A-Za-z0-9+/=]+)"/.exec(text);
  assert(Buffer.from(c.values).equals(Buffer.from(match[1],"base64")));
  assert.equal(c.meta.verifiedPixels,5721525);assert.equal(c.meta.missingCount,0);
  assert.equal(api.makePlan(c.meta,10).length,441);
  const cApp=renderer(c.meta,c.values);assert.equal(cApp.frames.at(-1).length,45);cApp.toggle(true);assert.equal(cApp.frames.at(-1).length,441);
  console.log("PASS: all 45 c scans match the basic viewer byte-for-byte; 5,721,525 BMP pixels match; 3D plane counts preserved.");

  if(process.argv.includes("--all-data")){
    const found=api.discover(await filesIn(path.join(root,"data")));let count=0,pixels=0;
    for(const group of found.groups){
      const dataset=await api.readDataset(group,group.first,group.last,100);count+=dataset.meta.count;pixels+=dataset.meta.verifiedPixels;
      const on=api.makePlan(dataset.meta,10);
      assert.equal(on.filter(p=>Number.isInteger(p.layer)).length,dataset.meta.count);
      if(group.series==="u"&&group.first===1&&group.last===101){
        assert.equal(dataset.meta.missingCount,70);assert.equal(dataset.meta.positionsMm.at(-1),10000);
        assert.equal(on.length,292);assert(!on.some(p=>p.x>2900&&p.x<10000));
        const mip=api.buildProjection(dataset.meta,dataset.values,10);
        for(let z=0;z<432;z++)for(let x=291;x<1000;x++)assert(Number.isNaN(mip.values[z*mip.width+x]));
      }
    }
    console.log(`PASS: ${found.groups.length} additional series, ${count} scans, ${pixels.toLocaleString()} BMP pixels; u31–u100 remain empty.`);
    console.log(`Unnumbered related files excluded: ${found.unmatched.length}.`);
  }
  console.log("Browser file picker, frame messaging in an actual browser, and GPU pixels remain unverified here.");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
