/* Offline MIRA feasibility viewer. No network access or external libraries. */
"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const status = $("renderStatus");
  try {
    if (!window.MIRA_DATA || !window.MIRA_BASE64) throw new Error("prototype/data.js が見つかりません。");
    const meta = window.MIRA_DATA;
    const W = meta.width, H = meta.height, N = meta.count, size = W * H;
    const decoded = atob(window.MIRA_BASE64);
    const values = Uint8Array.from(decoded, c => c.charCodeAt(0));
    window.MIRA_BASE64 = null;
    if (values.length !== N * size) throw new Error("断面データのサイズが一致しません。");
    const palette = meta.palette;
    const length = meta.lengthMm, hs = meta.heightSpanMm, ds = meta.depthMm;
    $("summary").textContent = `${meta.folder} ｜ ${N}断面 ｜ 横${meta.stepMm} mm間隔 ｜ 測定位置 0–${length.toLocaleString()} mm`;
    $("scan").max = N - 1;
    $("depth").max = ds;
    $("depth").value = ds;
    $("tickInterval").textContent = meta.stepMm / 10;
    $("verification").textContent = `${N} × ${W} × ${H} 点。元のBMPと全45断面を画素照合済み（カーソル線を除く）。反射強度0–254をそのまま使用。深さ0–${ds} mm、高さ方向${meta.heightMinMm}–${meta.heightMinMm + hs} mm。ファイル番号の昇順に${meta.stepMm} mm間隔で配置。データはこのPC内で表示し、外部へ送信しません。`;
    $("colorbar").style.background = `linear-gradient(to right,${palette.filter((_, i) => i % 8 === 0 || i === 254).map(c => `rgb(${c.join(",")})`).join(",")})`;

    const state = {threshold: 100, opacity: .75, depth: ds, scan: 0, flip: false, interpolate: false, showMeasurementTicks: true,
      yaw: -.48, pitch: .55, zoom: 1, panX: 0, panY: 0};
    // Ten intervals per measurement gap: 100 mm measurements become 10 mm samples.
    const interpolationSteps = 10;
    const sliceImage = document.createElement("canvas");
    sliceImage.width = W; sliceImage.height = H;
    const sliceContext = sliceImage.getContext("2d");
    const mipImage = document.createElement("canvas");
    mipImage.width = N; mipImage.height = H;
    const mipContext = mipImage.getContext("2d");
    const mip = new Uint8Array(N * H);
    for (let n = 0; n < N; n++) for (let z = 0; z < H; z++) {
      let maximum = 0;
      const start = n * size + z * W;
      for (let x = 0; x < W; x++) maximum = Math.max(maximum, values[start + x]);
      mip[z * N + n] = maximum;
    }

    function canvas2d(canvas) {
      const {width, height} = canvas.getBoundingClientRect();
      const ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      const ctx = canvas.getContext("2d");
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.font = '10px "Yu Gothic UI",Meiryo,sans-serif';
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = false;
      return {ctx, width, height};
    }
    function drawSection() {
      const image = sliceContext.createImageData(W, H);
      for (let i = 0; i < size; i++) {
        const c = palette[values[state.scan * size + i]];
        image.data.set([c[0], c[1], c[2], 255], i * 4);
      }
      sliceContext.putImageData(image, 0, 0);
      const {ctx, width, height} = canvas2d($("section"));
      const left = 40, top = 27, pw = width - 53, ph = height - 58;
      ctx.drawImage(sliceImage, left, top, pw, ph);
      ctx.fillStyle = "#4c606e"; ctx.textAlign = "center";
      for (const x of [-200, -100, 0, 100, 200]) {
        const px = left + (x - meta.heightMinMm) / hs * pw;
        ctx.fillText(x, px, top - 9);
      }
      ctx.fillText("高さ方向（元画面 X、mm）", left + pw / 2, height - 8);
      ctx.textAlign = "right";
      for (const d of [0, 100, 200, 300, 400, 500, 600, 700, ds]) {
        ctx.fillText(d, left - 6, top + d / ds * ph + 3);
      }
      ctx.textAlign = "left"; ctx.fillText("深さ mm", 4, 13);
      $("scanValue").textContent = `c${meta.numbers[state.scan]} · ${(state.scan * meta.stepMm).toLocaleString()} mm`;
      $("original").href = `${encodeURIComponent(meta.folder)}/${encodeURIComponent(meta.names[state.scan])}.bmp`;
    }
    // Every measurement gets a short tick; only text labels are spaced out to remain readable.
    function measurementLabelIndices(screenSpan) {
      if (N === 1 || screenSpan < 70) return [state.scan];
      const spacing = screenSpan / (N - 1);
      const stride = Math.max(1, Math.ceil(70 / spacing));
      const result = [];
      for (let n = 0; n < N; n += stride) result.push(n);
      if (result[result.length - 1] !== N - 1) {
        if ((N - 1 - result[result.length - 1]) * spacing < 70) result.pop();
        result.push(N - 1);
      }
      return result;
    }
    let projectionBounds, interpolatedMip;
    function buildInterpolatedProjection() {
      const count = (N - 1) * interpolationSteps + 1;
      const result = new Float32Array(count * H);
      for (let z = 0; z < H; z++) {
        for (let n = 0; n < N - 1; n++) {
          const target = z * count + n * interpolationSteps;
          result[target] = mip[z * N + n];
          const first = n * size + z * W, second = first + size;
          for (let x = 0; x < W; x++) {
            const a = values[first + x], b = values[second + x];
            for (let s = 1; s < interpolationSteps; s++) {
              const value = a + (b - a) * (s / interpolationSteps);
              if (value > result[target + s]) result[target + s] = value;
            }
          }
        }
        result[z * count + count - 1] = mip[z * N + N - 1];
      }
      // Interpolate each height/depth sample before finding the height maximum.
      // Interpolating the already-projected maxima would invent stronger signals.
      return result;
    }
    function drawProjection() {
      if (state.interpolate && !interpolatedMip) interpolatedMip = buildInterpolatedProjection();
      const samples = state.interpolate ? interpolatedMip : mip;
      const steps = state.interpolate ? interpolationSteps : 1;
      const count = (N - 1) * steps + 1;
      if (mipImage.width !== count) mipImage.width = count;
      const image = mipContext.createImageData(count, H);
      for (let i = 0; i < samples.length; i++) {
        const value = samples[i], z = Math.floor(i / count) / H * ds;
        const c = value >= state.threshold && z <= state.depth ? palette[Math.round(value)] : [0, 0, 0];
        image.data.set([c[0], c[1], c[2], 255], i * 4);
      }
      mipContext.putImageData(image, 0, 0);
      const {ctx, width, height} = canvas2d($("projection"));
      const left = 42, top = 9, pw = width - 65, ph = height - 54;
      // Keep the physical horizontal scale fixed when the raster sample count changes.
      // The original outer half-cells are 50 mm; interpolation samples have 5 mm half-cells.
      const inset = (1-1/steps)/2/N*pw, imageWidth = count/steps/N*pw;
      projectionBounds = {left, top, pw, ph, count:N, steps:1};
      ctx.fillStyle = "#000"; ctx.fillRect(left,top,pw,ph);
      ctx.drawImage(mipImage, left+inset, top, imageWidth, ph);
      ctx.fillStyle = "#4c606e"; ctx.textAlign = "right";
      for (const d of [0, 250, 500, ds]) ctx.fillText(d, left - 6, top + d / ds * ph + 3);
      ctx.textAlign = "center";
      const scanX = n => left + (n + .5) / N * pw;
      if (state.showMeasurementTicks) {
        for (let n = 0; n < N; n++) {
          const selected = n === state.scan, x = scanX(n);
          ctx.strokeStyle = selected ? "#9d6e09" : "#708796";
          ctx.lineWidth = selected ? 2 : 1;
          ctx.beginPath(); ctx.moveTo(x,top+ph); ctx.lineTo(x,top+ph+(selected?8:5)); ctx.stroke();
        }
        for (const n of measurementLabelIndices(scanX(N-1)-scanX(0))) {
          ctx.fillText(n*meta.stepMm,scanX(n),height-32);
          ctx.fillText(`c${meta.numbers[n]}`,scanX(n),height-18);
        }
      } else {
        for (const d of [0, 1000, 2000, 3000, 4000, length]) {
          if (d > length) continue;
          ctx.fillText(d, scanX(d/meta.stepMm), height - 32);
        }
      }
      ctx.textAlign = "right"; ctx.fillText("横位置 mm", width - 3, height - 2);
      const sx = scanX(state.scan);
      ctx.strokeStyle = "#fff2ae"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(sx, top); ctx.lineTo(sx, top + ph); ctx.stroke();
    }

    const canvas = $("volume"), viewport = $("viewport");
    const gl = canvas.getContext("webgl2", {alpha: false, antialias: true, preserveDrawingBuffer: true});
    if (!gl) throw new Error("このブラウザーではWebGL 2を利用できません。ChromeまたはEdgeで開いてください。");
    if (gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) < N) throw new Error("GPUの断面枚数上限を超えています。");
    function shader(type, source) {
      const s = gl.createShader(type);
      gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    function program(vs, fs) {
      const p = gl.createProgram();
      gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    }
    const planeProgram = program(`#version 300 es
      precision highp float;
      layout(location=0) in vec3 aPosition;
      layout(location=1) in vec2 aUV;
      layout(location=2) in float aLayer;
      uniform mat4 uMatrix;
      uniform float uFlip;
      out vec2 vUV;
      flat out float vLayer;
      void main(){gl_Position=uMatrix*vec4(aPosition.x,aPosition.y*uFlip,aPosition.z,1.0);vUV=aUV;vLayer=aLayer;}
    `, `#version 300 es
      precision highp float;
      precision highp sampler2DArray;
      in vec2 vUV;
      flat in float vLayer;
      uniform sampler2DArray uData;
      uniform sampler2D uPalette;
      uniform float uThreshold;
      uniform float uOpacity;
      uniform float uSampleWeight;
      uniform float uDepthLimit;
      out vec4 color;
      void main(){
        if(vUV.y>uDepthLimit) discard;
        float lower=floor(vLayer);
        float value=floor(texture(uData,vec3(vUV,lower)).r*255.0+0.5);
        float fraction=fract(vLayer);
        if(fraction>0.0){
          float upper=min(lower+1.0,float(textureSize(uData,0).z-1));
          float nextValue=floor(texture(uData,vec3(vUV,upper)).r*255.0+0.5);
          value=mix(value,nextValue,fraction);
        }
        if(value<uThreshold) discard;
        vec3 rgb=texelFetch(uPalette,ivec2(int(floor(value+0.5)),0),0).rgb;
        float alpha=uOpacity*(0.25+0.75*(value-uThreshold)/max(1.0,254.0-uThreshold));
        // Compensate for the increased number of planes when interpolation is on.
        if(uSampleWeight<1.0) alpha=1.0-pow(1.0-alpha,uSampleWeight);
        color=vec4(rgb,alpha);
      }
    `);
    const lineProgram = program(`#version 300 es
      layout(location=0) in vec3 aPosition;
      uniform mat4 uMatrix;
      void main(){gl_Position=uMatrix*vec4(aPosition,1.0);}
    `, `#version 300 es
      precision highp float;
      uniform vec4 uColor;
      out vec4 color;
      void main(){color=uColor;}
    `);
    const uniforms = {};
    for (const name of ["uMatrix", "uFlip", "uThreshold", "uOpacity", "uSampleWeight", "uDepthLimit", "uData", "uPalette"])
      uniforms[name] = gl.getUniformLocation(planeProgram, name);
    const lineMatrix = gl.getUniformLocation(lineProgram, "uMatrix");
    const lineColor = gl.getUniformLocation(lineProgram, "uColor");

    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, W, H, N, 0, gl.RED, gl.UNSIGNED_BYTE, values);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const paletteTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, paletteTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 255, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(palette.flat()));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.useProgram(planeProgram); gl.uniform1i(uniforms.uData, 0); gl.uniform1i(uniforms.uPalette, 1);

    const y0 = -hs / 2, y1 = hs / 2, z0 = ds / 2, z1 = -ds / 2;
    function createPlanes(steps) {
      const count = (N - 1) * steps + 1, vertices = [];
      for (let n = 0; n < count; n++) {
        const layer = n / steps, x = layer * meta.stepMm - length / 2;
        for (const [y, z, u, v] of [[y0,z0,0,0],[y1,z0,1,0],[y0,z1,0,1],[y0,z1,0,1],[y1,z0,1,0],[y1,z1,1,1]])
          vertices.push(x,y,z,u,v,layer);
      }
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
      for (const [location, components, offset] of [[0,3,0],[1,2,12],[2,1,20]]) {
        gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, components, gl.FLOAT, false, 24, offset);
      }
      return {vao, count};
    }
    const measuredPlanes = createPlanes(1);
    let interpolatedPlanes;
    const lineVao = gl.createVertexArray(); gl.bindVertexArray(lineVao);
    const lineBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    function rotate(x, y, z) {
      const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw);
      const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
      const rx = cy * x + sy * z, rz = -sy * x + cy * z;
      return [rx, cp * y - sp * rz, sp * y + cp * rz];
    }
    let viewSpan, viewWidth, viewHeight;
    function matrix() {
      const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw);
      const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch), aspect = viewWidth / viewHeight;
      // Use the physical bounding box to fit any view without changing proportions.
      const corners = [];
      for (const x of [-length/2,length/2]) for (const y of [y0,y1]) for (const z of [z0,z1]) corners.push(rotate(x,y,z));
      const rx = Math.max(...corners.map(p => Math.abs(p[0])));
      const ry = Math.max(...corners.map(p => Math.abs(p[1])));
      viewSpan = Math.max(rx / aspect, ry, 160) * 1.24 / state.zoom;
      const ax = 1 / (viewSpan * aspect), ay = 1 / viewSpan, az = -1 / 12000;
      return new Float32Array([
        cy*ax, sp*sy*ay, -cp*sy*az, 0,
        0, cp*ay, sp*az, 0,
        sy*ax, -sp*cy*ay, cp*cy*az, 0,
        state.panX*2/viewWidth, -state.panY*2/viewHeight, 0, 1]);
    }
    function project(point) {
      const p = rotate(...point), aspect = viewWidth / viewHeight;
      return [(p[0] / (viewSpan * aspect) + 1) * viewWidth / 2 + state.panX,
        (1 - p[1] / viewSpan) * viewHeight / 2 + state.panY];
    }
    function lines(points, color, m) {
      gl.useProgram(lineProgram); gl.uniformMatrix4fv(lineMatrix, false, m); gl.uniform4fv(lineColor, color);
      gl.bindVertexArray(lineVao); gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(points.flat()), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINES, 0, points.length);
    }
    function drawVolume() {
      const rect = viewport.getBoundingClientRect(), ratio = Math.min(devicePixelRatio || 1, 2);
      viewWidth = rect.width; viewHeight = rect.height;
      const pixelWidth = Math.round(rect.width * ratio), pixelHeight = Math.round(rect.height * ratio);
      // Resizing the WebGL drawing buffer on every drag frame is unnecessary.
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(16/255,28/255,41/255,1); gl.clear(gl.COLOR_BUFFER_BIT);
      const m = matrix();
      if (state.interpolate && !interpolatedPlanes) interpolatedPlanes = createPlanes(interpolationSteps);
      const planes = state.interpolate ? interpolatedPlanes : measuredPlanes;
      gl.useProgram(planeProgram); gl.bindVertexArray(planes.vao);
      gl.uniformMatrix4fv(uniforms.uMatrix, false, m); gl.uniform1f(uniforms.uFlip, state.flip ? -1 : 1);
      gl.uniform1f(uniforms.uThreshold, state.threshold); gl.uniform1f(uniforms.uOpacity, state.opacity);
      gl.uniform1f(uniforms.uDepthLimit, state.depth / ds);
      gl.uniform1f(uniforms.uSampleWeight, N / planes.count);
      const order = Array.from({length:planes.count}, (_,i) => i);
      if (Math.sin(state.yaw) > 0) order.reverse();
      for (const n of order) gl.drawArrays(gl.TRIANGLES, n * 6, 6);
      const box = [], clipZ = z0 - state.depth;
      const corners = [[-length/2,y0,z0],[length/2,y0,z0],[-length/2,y1,z0],[length/2,y1,z0],
        [-length/2,y0,clipZ],[length/2,y0,clipZ],[-length/2,y1,clipZ],[length/2,y1,clipZ]];
      for (const [a,b] of [[0,1],[0,2],[1,3],[2,3],[4,5],[4,6],[5,7],[6,7],[0,4],[1,5],[2,6],[3,7]]) box.push(corners[a],corners[b]);
      lines(box,[.48,.61,.71,.5],m);
      const axisCanvas = $("axes");
      if (axisCanvas.width !== canvas.width) axisCanvas.width = canvas.width;
      if (axisCanvas.height !== canvas.height) axisCanvas.height = canvas.height;
      const ctx = axisCanvas.getContext("2d"); ctx.setTransform(ratio,0,0,ratio,0,0);
      ctx.clearRect(0,0,viewWidth,viewHeight);
      ctx.font = '11px "Yu Gothic UI",Meiryo,sans-serif';
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      // Canvas strokes provide a reliable CSS-pixel width on GPUs where WebGL
      // lineWidth is limited to one pixel. Use the same 3D projection as the volume.
      function sectionFrame(n,color,width) {
        const x=n*meta.stepMm-length/2;
        const corners=[[x,y0,z0],[x,y1,z0],[x,y1,clipZ],[x,y0,clipZ]];
        ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineJoin="round";
        ctx.beginPath();
        corners.forEach((corner,i)=>{
          const p=project(corner);
          if(i===0)ctx.moveTo(...p);else ctx.lineTo(...p);
        });
        ctx.closePath();ctx.stroke();
      }
      // Only the measurement shown in the right-hand panel gets a full frame.
      sectionFrame(state.scan,"#ffff00",2.5);
      function label(point, text, dx, dy, color="#b5c9d9") {
        const [x,y] = project(point); const px=x+dx, py=y+dy;
        ctx.lineWidth=3; ctx.strokeStyle="#101c29"; ctx.strokeText(text,px,py);
        ctx.fillStyle=color; ctx.fillText(text,px,py);
      }
      if (state.showMeasurementTicks) {
        const start=project([-length/2,y0,z0]), end=project([length/2,y0,z0]);
        const dx=end[0]-start[0], dy=end[1]-start[1], span=Math.hypot(dx,dy);
        let nx=span>1?-dy/span:0, ny=span>1?dx/span:1;
        if(ny<0){nx=-nx;ny=-ny;}
        for(let n=0;n<N;n++) {
          const [x,y]=project([n*meta.stepMm-length/2,y0,z0]), selected=n===state.scan;
          const tickLength=selected?9:6;
          ctx.strokeStyle=selected?"#ffff00":"#9ab3c7";ctx.lineWidth=selected?2:1;
          ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+nx*tickLength,y+ny*tickLength);ctx.stroke();
        }
        for(const n of measurementLabelIndices(span)) {
          const point=[n*meta.stepMm-length/2,y0,z0];
          label(point,`${n*meta.stepMm}`,nx*18,ny*18);
          label(point,`c${meta.numbers[n]}`,nx*32,ny*32);
        }
        label([0,y0,z0],"横位置 mm",nx*51,ny*51,"#dce8f1");
      } else {
        for (const d of [0,1000,2000,3000,4000,length]) {
          if (d <= length) label([d-length/2,y0,z0],`${d}`,0,16);
        }
        label([0,y0,z0],"横位置 mm",0,35,"#dce8f1");
      }
      label([-length/2,y1,z0],`高さ +${hs/2} mm`,-8,-18);
      label([-length/2,y0,z0],`−${hs/2}`,-28,-2);
      label([-length/2,y0,clipZ],`深さ ${state.depth} mm`,-10,20);
      const glError = gl.getError();
      if (glError) throw new Error(`WebGL描画エラー ${glError}`);
      const mode = state.interpolate ? `${N}測定断面＋${planes.count-N}補間断面` : `${N}測定断面`;
      status.textContent = `${mode} · 下限 ${state.threshold}/254 · 選択 c${meta.numbers[state.scan]}`;
      canvas.dataset.rendered = "true";
    }
    let queued = false;
    function schedule() {
      if (queued) return; queued = true;
      requestAnimationFrame(() => { queued=false; try { drawVolume(); } catch(e) { fail(e); } });
    }
    function fail(error) { status.classList.add("error"); status.textContent = error.message; console.error(error); }
    function selectScan(n) {
      state.scan = Math.max(0,Math.min(N-1,n)); $("scan").value = state.scan;
      drawSection(); drawProjection(); schedule();
    }
    $("threshold").addEventListener("input", e => {
      state.threshold = Number(e.target.value); $("thresholdValue").value = `${state.threshold} / 254`;
      drawProjection(); schedule();
    });
    $("opacity").addEventListener("input", e => {
      state.opacity = Number(e.target.value)/100; $("opacityValue").value = `${e.target.value}%`; schedule();
    });
    $("depth").addEventListener("input", e => {
      state.depth = Number(e.target.value); $("depthValue").value = `${state.depth} mm`; drawProjection(); schedule();
    });
    $("flipHeight").addEventListener("change", e => {state.flip=e.target.checked; schedule();});
    $("measurementTicks").addEventListener("change", e => {
      state.showMeasurementTicks=e.target.checked;
      drawProjection(); schedule();
    });
    $("interpolate").addEventListener("change", e => {
      state.interpolate=e.target.checked;
      $("interpolationMode").textContent=state.interpolate ? "断面間を線形補間・実寸比" : "断面間の補間なし・実寸比";
      $("projectionMode").textContent=state.interpolate ? "補間後の高さ方向の最大強度・クリックで断面を選択" : "高さ方向の最大強度・クリックで断面を選択";
      drawProjection(); schedule();
    });
    $("scan").addEventListener("input", e => selectScan(Number(e.target.value)));
    $("projection").addEventListener("click", e => {
      const r=e.currentTarget.getBoundingClientRect();
      const sample=(e.clientX-r.left-projectionBounds.left)/projectionBounds.pw*projectionBounds.count-.5;
      const n=Math.round(sample/projectionBounds.steps);
      selectScan(n);
    });
    function setView(name) {
      const views = {oblique:[-.48,.55],front:[0,0],top:[0,Math.PI/2],side:[-Math.PI/2,0]};
      [state.yaw,state.pitch]=views[name]; state.zoom=1; state.panX=state.panY=0;
      document.querySelectorAll("[data-view]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.view===name)));
      schedule();
    }
    document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.view)));
    $("reset").addEventListener("click",()=>setView("oblique"));
    let drag;
    viewport.addEventListener("pointerdown", e => {
      if (drag || (e.button !== 0 && e.button !== 1)) return;
      e.preventDefault();
      viewport.focus({preventScroll:true}); viewport.setPointerCapture(e.pointerId);
      drag={id:e.pointerId,x:e.clientX,y:e.clientY,pan:e.shiftKey||e.button===1};
    });
    viewport.addEventListener("pointermove", e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx=e.clientX-drag.x, dy=e.clientY-drag.y;
      if(drag.pan){state.panX+=dx;state.panY+=dy;}
      else {state.yaw+=dx*.008; state.pitch=Math.max(-1.55,Math.min(1.55,state.pitch+dy*.008));}
      drag.x=e.clientX;drag.y=e.clientY;
      document.querySelectorAll("[data-view]").forEach(b=>b.setAttribute("aria-pressed","false"));
      schedule();
    });
    function finishDrag(e) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const pointerId = drag.id;
      drag=null;
      if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
    }
    viewport.addEventListener("pointerup",finishDrag);
    viewport.addEventListener("pointercancel",finishDrag);
    viewport.addEventListener("lostpointercapture",finishDrag);
    window.addEventListener("blur",()=>finishDrag());
    viewport.addEventListener("wheel",e=>{e.preventDefault();state.zoom=Math.max(.3,Math.min(8,state.zoom*Math.exp(-e.deltaY*.001)));schedule();},{passive:false});
    viewport.addEventListener("keydown",e=>{
      if(e.key==="ArrowLeft")state.yaw-=.1;
      else if(e.key==="ArrowRight")state.yaw+=.1;
      else if(e.key==="ArrowUp")state.pitch=Math.max(-1.55,state.pitch-.1);
      else if(e.key==="ArrowDown")state.pitch=Math.min(1.55,state.pitch+.1);
      else return;
      e.preventDefault();schedule();
    });
    canvas.addEventListener("webglcontextlost", e=>{e.preventDefault();fail(new Error("GPUの表示が中断されました。ページを再読込みしてください。"));});
    const observer = new ResizeObserver(()=>{drawSection();drawProjection();schedule();});
    observer.observe(viewport); observer.observe($("section"));
    drawSection(); drawProjection(); drawVolume();
  } catch (error) {
    status.classList.add("error"); status.textContent=error.message; console.error(error);
  }
})();
