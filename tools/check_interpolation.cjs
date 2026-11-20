/* Numerical and control-flow checks, using a simulated DOM/WebGL API.
 * This does not validate browser/GPU pixels or compile GLSL on a real GPU.
 * Run: node tools/check_interpolation.cjs [--real-data]
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");

function viewer(fixture) {
  const elements = new Map(), uniforms = new Map(), errors = [];
  const staticUploads = [], frames = [], textureUploads = [];
  let frame;
  const gl = new Proxy({
    createShader:()=>({}), createProgram:()=>({}), createTexture:()=>({}),
    createVertexArray:()=>({}), createBuffer:()=>({}),
    getShaderParameter:()=>true, getProgramParameter:()=>true,
    getParameter:()=>256, getError:()=>0,
    getUniformLocation:(_,name)=>name,
    uniform1f:(name,value)=>uniforms.set(name,value),
    uniformMatrix4fv:(name,_,value)=>uniforms.set(name,Array.from(value)),
    texImage3D:(...args)=>textureUploads.push(args),
    bufferData:(_,data,usage)=>{if(usage==="STATIC_DRAW")staticUploads.push(Array.from(data));},
    clear:()=>{frame=[];frames.push(frame);},
    drawArrays:(type,start,count)=>{if(type==="TRIANGLES")frame.push({start,count});},
  }, {get:(target,key)=>key in target ? target[key] :
    typeof key==="string" && key===key.toUpperCase() ? key : ()=>{}});
  function element(id) {
    if(elements.has(id)) return elements.get(id);
    const context = new Proxy({
      createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}),
      putImageData:image=>{context.image=image;},
    }, {get:(target,key)=>key in target ? target[key] : ()=>{}});
    const e = {id,width:296,height:432,value:"0",checked:false,events:{},dataset:{},style:{},
      classList:{add:()=>{}},context,
      getBoundingClientRect:()=>({left:0,top:0,width:id==="section"?340:1000,height:id==="projection"?153:445}),
      getContext:type=>type==="webgl2"?gl:context,
      addEventListener:(type,fn)=>{e.events[type]=fn;},setAttribute:()=>{},focus:()=>{},
      setPointerCapture:()=>{},hasPointerCapture:()=>false,releasePointerCapture:()=>{}};
    elements.set(id,e);return e;
  }
  const buttons=["oblique","front","top","side"].map(name=>{
    const b=element(name);b.dataset.view=name;return b;
  });
  let canvasCount=0;
  const sandbox={Uint8Array,Float32Array,Math,Array,Number,String,devicePixelRatio:1,
    atob:text=>Buffer.from(text,"base64").toString("binary"),
    document:{getElementById:element,createElement:()=>element(`offscreen-${canvasCount++}`),querySelectorAll:()=>buttons},
    console:{error:error=>errors.push(String(error))},
    ResizeObserver:class{observe(){}},requestAnimationFrame:fn=>fn(),addEventListener:()=>{}};
  sandbox.window=sandbox;
  vm.createContext(sandbox);
  if(fixture) {
    sandbox.MIRA_DATA=fixture.meta;
    sandbox.MIRA_BASE64=Buffer.from(fixture.values).toString("base64");
  } else {
    vm.runInContext(fs.readFileSync(path.join(root,"prototype/data.js"),"utf8"),sandbox);
  }
  vm.runInContext(fs.readFileSync(path.join(root,"prototype/viewer.js"),"utf8"),sandbox);
  assert.equal(errors.length,0,errors.join("\n"));
  return {element,uniforms,staticUploads,frames,textureUploads,errors,meta:sandbox.MIRA_DATA,
    projection:()=>element("offscreen-1").context.image,
    section:()=>element("offscreen-0").context.image,
    toggle:on=>element("interpolate").events.change({target:{checked:on}})};
}

const fixture={
  meta:{folder:"fixture",count:2,width:2,height:1,stepMm:100,lengthMm:100,
    heightMinMm:-257,heightSpanMm:514,depthMm:750,names:["sample_c1","sample_c2"],numbers:[1,2],
    palette:Array.from({length:255},(_,i)=>[i,i,i])},
  values:[200,0,0,200],
};
const small=viewer(fixture);
const original=small.projection().data.slice(), originalSection=small.section().data.slice();
assert.equal(small.frames.at(-1).length,2);
small.toggle(true);
assert.equal(small.frames.at(-1).length,11);
// Opposite peaks: actual midpoint samples are [100,100], so MIP must be 100.
// Interpolating the endpoint MIPs [200,200] instead would incorrectly give 200.
assert.deepEqual(Array.from(small.projection().data.filter((_,i)=>i%4===0)),
  [200,180,160,140,120,100,120,140,160,180,200]);
assert.deepEqual(small.section().data,originalSection,"selected measurement must stay original");
small.element("threshold").events.input({target:{value:"150"}});
assert.equal(small.projection().data[5*4],0,"threshold must apply after scalar interpolation");
small.element("threshold").events.input({target:{value:"100"}});
small.toggle(false);
assert.deepEqual(small.projection().data,original,"off must restore original projection exactly");
assert.equal(small.frames.at(-1).length,2);
assert.equal(small.uniforms.get("uSampleWeight"),1);
assert.equal(small.staticUploads.length,2,"only the two geometry variants should be built");
small.toggle(true);small.toggle(false);
assert.equal(small.staticUploads.length,2,"repeated toggles must reuse geometry");
assert.equal(small.errors.length,0,small.errors.join("\n"));
console.log("PASS: synthetic opposite peaks; midpoint and threshold; unchanged measured section; exact off restoration; cache reuse.");

if(process.argv.includes("--real-data")) {
  const real=viewer();
  const {width:W,height:H,count:N,palette,stepMm}=real.meta;
  const originalMip=real.projection().data.slice();
  const values=real.textureUploads[0][9];
  const originalValues=values.slice();
  real.element("scan").events.input({target:{value:"22"}});
  const section=real.section().data.slice();
  const viewport=real.element("viewport");
  viewport.events.pointerdown({button:0,pointerId:1,clientX:300,clientY:200,preventDefault(){}});
  viewport.events.pointermove({pointerId:1,clientX:390,clientY:230});
  viewport.events.pointerup({pointerId:1});
  const camera=real.uniforms.get("uMatrix").slice();
  const start=performance.now();real.toggle(true);
  const elapsed=Math.round(performance.now()-start);
  const count=(N-1)*10+1, image=real.projection();
  assert.equal(image.width,count);
  assert.equal(real.frames.at(-1).length,count);
  assert.equal(real.uniforms.get("uSampleWeight"),N/count);
  assert.deepEqual(real.uniforms.get("uMatrix"),camera,"toggle must preserve the camera");
  assert.equal(real.element("scanValue").textContent,"c23 · 2,200 mm");
  assert.deepEqual(real.section().data,section);
  const vertices=real.staticUploads[1];
  assert.equal(vertices.length,count*36);
  for(let n=0;n<N;n++) {
    assert.equal(vertices[n*10*36+5],n,"actual measurement layers must remain present");
    for(let z=0;z<H;z++) {
      const a=(z*count+n*10)*4,b=(z*N+n)*4;
      assert.deepEqual(Array.from(image.data.slice(a,a+4)),Array.from(originalMip.slice(b,b+4)));
    }
  }
  assert.equal(vertices[0],-real.meta.lengthMm/2);
  assert.equal(vertices[(count-1)*36],real.meta.lengthMm/2);
  assert.equal(vertices[36]-vertices[0],stepMm/10);
  for(const [n,s] of [[0,1],[0,5],[22,4],[N-2,9]]) for(const z of [0,100,150,H-1]) {
    const a=n*W*H+z*W,b=a+W*H;
    let maximum=0;
    for(let x=0;x<W;x++) maximum=Math.max(maximum,((10-s)*values[a+x]+s*values[b+x])/10);
    const expected=maximum>=100?palette[Math.round(maximum)]:[0,0,0];
    const offset=(z*count+n*10+s)*4;
    assert.deepEqual(Array.from(image.data.slice(offset,offset+3)),Array.from(expected));
  }
  // Both projection modes must select the nearest actual measurement, not a synthetic one.
  const rect=real.element("projection").getBoundingClientRect();
  real.element("projection").events.click({currentTarget:real.element("projection"),clientX:42+(440+.5)/count*(rect.width-65)});
  assert.equal(real.element("scanValue").textContent,"c45 · 4,400 mm");
  real.element("depth").events.input({target:{value:"300"}});
  real.element("opacity").events.input({target:{value:"50"}});
  real.toggle(false);
  assert.equal(real.frames.at(-1).length,N);
  assert.equal(real.uniforms.get("uDepthLimit"),.4);
  assert.equal(real.uniforms.get("uOpacity"),.5);
  assert.deepEqual(real.uniforms.get("uMatrix"),camera);
  real.element("depth").events.input({target:{value:"750"}});
  assert.deepEqual(real.projection().data,originalMip);
  assert.deepEqual(values,originalValues,"no changes to the uploaded measurement intensities");
  assert.equal(real.errors.length,0,real.errors.join("\n"));
  console.log(`PASS: real ${N} scans -> ${count} planes; ${N*H} measured projection points unchanged; fractional samples; camera/selection/depth/opacity preserved. First ON: ${elapsed} ms.`);
}
console.log("Browser/GPU rendering remains unverified; these checks use a simulated DOM/WebGL API.");
