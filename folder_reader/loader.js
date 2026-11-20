"use strict";
(() => {
  const $=id=>document.getElementById(id),api=window.MiraFolderData;
  let groups=[],currentFrame=null,pending=null,busy=false;
  function status(text,error=false){$("status").textContent=text;$("status").classList.toggle("error",error);}
  function lock(value){busy=value;for(const id of ["chooseFolder","series","first","last","stepMm","load"])$(id).disabled=value||(!groups.length&&id!=="chooseFolder"&&id!=="stepMm");}
  $("chooseFolder").addEventListener("click",()=>{$("folder").value="";$("folder").click();});
  function chooseSeries(){
    const group=groups[Number($("series").value)];if(!group)return;
    for(const id of ["first","last"]){$(id).min=group.first;$(id).max=group.last;}
    $("first").value=group.first;$("last").value=group.last;
    const complete=[...group.records.values()].filter(r=>r.files.cfg&&r.files.bin).length;
    status(`${group.directory} / ${group.series} ｜ ${group.first}〜${group.last} ｜ CFG・BINのある測点 ${complete}件`);
  }
  $("folder").addEventListener("change",()=>{
    if(busy||!$("folder").files.length)return;
    try{
      const found=api.discover($("folder").files);groups=found.groups;
      $("series").replaceChildren();
      for(let i=0;i<groups.length;i++){
        const g=groups[i],option=document.createElement("option");option.value=i;
        option.textContent=`${g.directory} / ${g.series}（${g.first}〜${g.last}）`;
        $("series").append(option);
      }
      lock(false);
      if(!groups.length){status("連番のCFG・BINファイルが見つかりません。",true);return;}
      $("series").value="0";chooseSeries();
      if(found.unmatched.length)status(`${$("status").textContent} ｜ 番号を読み取れない関連ファイル ${found.unmatched.length}件は対象外です。`);
    }catch(error){status(error.message,true);}
  });
  $("series").addEventListener("change",chooseSeries);
  $("loadForm").addEventListener("submit",async event=>{
    event.preventDefault();if(busy||!groups.length||!$("loadForm").reportValidity())return;
    const group=groups[Number($("series").value)];lock(true);
    try{
      const dataset=await api.readDataset(group,Number($("first").value),Number($("last").value),Number($("stepMm").value),
        (done,total,name)=>status(`読込み・照合中 ${done}/${total}${name?" · "+name:""}`));
      const frame=document.createElement("iframe");frame.className="reader-frame";frame.title=`${group.series}系列の3D表示`;
      frame.src="folder_reader/viewer.html";
      pending={frame,dataset,sent:false};currentFrame=frame;
      $("viewerHost").replaceChildren(frame);
      status(`${dataset.meta.count}測点を読込み済み。欠番${dataset.meta.missingCount}測点分は空白です。3D表示を準備しています。`);
    }catch(error){status(`${error.message}${currentFrame?"（下には前に読み込んだデータを表示しています。）":""}`,true);}
    finally{lock(false);}
  });
  window.addEventListener("message",event=>{
    // Local file origins are opaque; only the currently embedded viewer may reply.
    if(!currentFrame||event.source!==currentFrame.contentWindow||!event.data)return;
    const data=event.data;
    if(data.type==="mira-ready"&&pending&&!pending.sent){
      pending.sent=true;const dataset=pending.dataset;
      currentFrame.contentWindow.postMessage({type:"mira-data",meta:dataset.meta,buffer:dataset.values.buffer,originalFiles:dataset.originalFiles},"*",[dataset.values.buffer]);
      pending=null;
    }else if(data.type==="mira-height"&&Number.isFinite(data.height)){
      currentFrame.style.height=`${Math.max(500,Math.min(3000,data.height))}px`;
    }else if(data.type==="mira-rendered"){
      status(`${data.count}測点を表示中。欠番${data.missingCount}測点分は空白です。BMP画素照合 ${data.verifiedImages}/${data.count}測点。`);
    }else if(data.type==="mira-error")status(`3D表示：${data.message}`,true);
  });
})();
