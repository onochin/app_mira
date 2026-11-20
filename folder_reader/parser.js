/* Local-file parsing and gap-aware geometry. No network requests or packages. */
"use strict";
((root) => {
  function discover(files) {
    const groups = new Map(), unmatched = [];
    for (const file of files) {
      const match = /^(.*?)([A-Za-z]+)(\d+)\.(cfg|bin|bmp)$/i.exec(file.name);
      if (!match) {
        if (/\.(cfg|bin|bmp)$/i.test(file.name)) unmatched.push(file.name);
        continue;
      }
      const relative = file.webkitRelativePath || file.name;
      const directory = relative.includes("/") ? relative.slice(0,relative.lastIndexOf("/")) : "選択ファイル";
      const prefix = match[1]+match[2], key = directory+"\0"+prefix;
      if (!groups.has(key)) groups.set(key,{key,directory,prefix,series:match[2],records:new Map(),errors:[]});
      const group = groups.get(key), number = Number(match[3]), ext = match[4].toLowerCase();
      if (!Number.isSafeInteger(number)) {group.errors.push("測点番号が大きすぎます。");continue;}
      if (!group.records.has(number)) group.records.set(number,{number,stem:file.name.replace(/\.[^.]+$/,""),files:{}});
      const record = group.records.get(number);
      if (record.files[ext]) group.errors.push(`${group.series}${number} の .${ext} が重複しています。`);
      record.files[ext]=file;
    }
    const result = [...groups.values()];
    for (const group of result) {
      group.numbers=[...group.records.keys()].sort((a,b)=>a-b);
      group.first=group.numbers[0];group.last=group.numbers.at(-1);
    }
    return {groups:result.sort((a,b)=>a.directory.localeCompare(b.directory)||a.prefix.localeCompare(b.prefix)),unmatched};
  }

  function cfg(text) {
    const data={};
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match=/^(\d+):\s*(-?[\d.]+)\s*$/.exec(line);
      if (!match || !Number.isFinite(Number(match[2]))) throw new Error("CFGの形式に対応していません。");
      data[Number(match[1])]=Number(match[2]);
    }
    for (const key of [7,9,10,11,12]) if (!Number.isFinite(data[key])) throw new Error(`CFGに必要な項目${key}がありません。`);
    if(data[11]!==296 || data[12]!==432 || data[9]<=0 || data[10]<=0) throw new Error("この読込版は296×432点の保存断面に対応しています。");
    return data;
  }

  function decodeBin(buffer,width,height) {
    if(buffer.byteLength!==width*height*4) throw new Error("BINのサイズがCFGの断面サイズと一致しません。");
    const view=new DataView(buffer), output=new Uint8Array(width*height);
    for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
      const value=view.getInt32((y*width+x)*4,true);
      if(value<0 || value>254) throw new Error("BINの表示強度が対応範囲0〜254の外です。");
      output[y*width+width-1-x]=value;
    }
    return output;
  }

  function verifyBmp(buffer,values,config,palette) {
    const bmp=new DataView(buffer);
    if(buffer.byteLength<54 || bmp.getUint16(0,true)!==0x4d42) throw new Error("BMPヘッダーが不正です。");
    const offset=bmp.getUint32(10,true),width=bmp.getInt32(18,true),height=bmp.getInt32(22,true);
    if(width!==640 || height!==480 || bmp.getUint16(26,true)!==1 || bmp.getUint16(28,true)!==16 || bmp.getUint32(30,true)!==0)
      throw new Error("元BMPの形式に対応していません（640×480、16 bit RGB555が必要です）。");
    const stride=Math.ceil(width*16/32)*4;
    if(offset<54 || offset+stride*height>buffer.byteLength) throw new Error("BMPの画素データが不足しています。");
    const words=palette.map(([r,g,b])=>(Math.round(r*31/255)<<10)|(Math.round(g*31/255)<<5)|Math.round(b*31/255));
    let compared=0,mismatches=0;
    for(let y=0;y<432;y++) for(let x=0;x<296;x++) {
      if(x===config[17] || y===config[18]) continue;
      const word=bmp.getUint16(offset+(height-1-42-y)*stride+(294+x)*2,true)&0x7fff;
      compared++;if(word!==words[values[y*296+x]])mismatches++;
    }
    if(mismatches) throw new Error(`元BMPと表示強度の照合に不一致が${mismatches}画素あります。自動配置を中止しました。`);
    return compared;
  }

  async function readDataset(group,first,last,stepMm,onProgress=()=>{}) {
    if(group.errors.length) throw new Error(group.errors.join(" "));
    if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first>last || first<group.first || last>group.last)
      throw new Error("表示範囲を系列の番号範囲内で指定してください。");
    if(!Number.isFinite(stepMm)||stepMm<=0) throw new Error("測点間隔には0より大きいmm値を指定してください。");
    const slotCount=last-first+1;
    if(slotCount>1000) throw new Error("一度に表示できる番号範囲は1000測点分までです。表示範囲を狭めてください。");
    const selected=group.numbers.filter(n=>n>=first&&n<=last).map(n=>group.records.get(n));
    const records=selected.filter(r=>r.files.cfg&&r.files.bin);
    if(!records.length) throw new Error("指定範囲にCFGとBINの揃った測点がありません。");
    if(records.length>256) throw new Error("一度の読込みは実測256測点までです。表示範囲を狭めてください。");
    const palette=root.MiraPalette;
    if(!palette || palette.length!==255) throw new Error("カラーテーブルを読み込めません。");
    const width=296,height=432,size=width*height;
    const values=new Uint8Array(records.length*size),numbers=[],names=[],originalFiles=[];
    let geometry,verifiedImages=0,verifiedPixels=0;
    const incomplete=selected.filter(r=>!r.files.cfg||!r.files.bin).map(r=>`${group.series}${r.number}`);
    for(let i=0;i<records.length;i++) {
      const record=records[i];onProgress(i,records.length,`${group.series}${record.number}`);
      try {
        const config=cfg(await record.files.cfg.text());
        const shape=[config[11],config[12],config[7],config[9],config[10]];
        if(geometry && shape.some((v,j)=>v!==geometry[j])) throw new Error("断面の高さ・深さ範囲が揃っていません。同じ条件の範囲を選んでください。");
        geometry=shape;
        const scan=decodeBin(await record.files.bin.arrayBuffer(),width,height);
        if(record.files.bmp) {verifiedPixels+=verifyBmp(await record.files.bmp.arrayBuffer(),scan,config,palette);verifiedImages++;}
        values.set(scan,i*size);numbers.push(record.number);names.push(record.stem);originalFiles.push(record.files.bmp||null);
      } catch(error) {throw new Error(`${record.stem}: ${error.message}`);}
    }
    const meta={folder:group.directory,series:group.series,prefix:group.prefix,count:records.length,width,height,
      firstNumber:first,lastNumber:last,slotCount,numbers,names,stepMm,lengthMm:(slotCount-1)*stepMm,
      positionsMm:numbers.map(n=>(n-first)*stepMm),heightMinMm:geometry[2],heightSpanMm:geometry[3],depthMm:geometry[4],
      palette,verifiedImages,verifiedPixels,missingCount:slotCount-records.length,incomplete};
    onProgress(records.length,records.length,"");
    return {meta,values,originalFiles};
  }

  function makePlan(meta,steps) {
    const plan=[];
    for(let start=0;start<meta.count;) {
      let end=start;
      while(end+1<meta.count && meta.numbers[end+1]===meta.numbers[end]+1) end++;
      const measurements=end-start+1,count=(measurements-1)*steps+1,weight=measurements/count;
      for(let n=start;n<=end;n++) {
        plan.push({layer:n,x:meta.positionsMm[n],weight});
        if(n<end) for(let s=1;s<steps;s++) plan.push({layer:n+s/steps,x:meta.positionsMm[n]+meta.stepMm*s/steps,weight});
      }
      start=end+1;
    }
    return plan;
  }

  function buildProjection(meta,volume,steps) {
    const {width:W,height:H,count:N,slotCount,numbers,firstNumber}=meta,size=W*H;
    const count=(slotCount-1)*steps+1,values=new Float32Array(count*H);
    values.fill(NaN);
    for(let n=0;n<N;n++) for(let z=0;z<H;z++) {
      const target=z*count+(numbers[n]-firstNumber)*steps,first=n*size+z*W;
      let maximum=0;
      for(let x=0;x<W;x++)maximum=Math.max(maximum,volume[first+x]);
      values[target]=maximum;
      if(steps===1 || n+1===N || numbers[n+1]!==numbers[n]+1)continue;
      for(let s=1;s<steps;s++) {
        let interpolated=0;
        for(let x=0;x<W;x++) interpolated=Math.max(interpolated,((steps-s)*volume[first+x]+s*volume[first+size+x])/steps);
        values[target+s]=interpolated;
      }
    }
    return {values,width:count,steps};
  }
  root.MiraFolderData={discover,cfg,decodeBin,verifyBmp,readDataset,makePlan,buildProjection};
})(typeof window!=="undefined"?window:globalThis);
