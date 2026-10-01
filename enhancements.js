'use strict';
(() => {
  let scannerStream=null, scanTimer=null;
  function n(v){return window.ILI_LANG?.number?.(Number(v).toLocaleString()) ?? Number(v).toLocaleString();}
  async function refreshMarket(){
    try{
      const p=await api('/api/price');
      appConfig.iliTomanRate=p.iliTomanRate;
      const pe=$('#stat-price'); if(pe) pe.textContent=n(p.iliTomanRate)+' تومان';
      const ce=$('#stat-price-change'); if(ce) ce.textContent=(p.changePercent>=0?'▲ +':'▼ ')+n(Math.abs(p.changePercent))+'%';
      if($('#market-btc')) $('#market-btc').textContent=p.market?.btcUsd?n(p.market.btcUsd)+' USD':'—';
      if($('#market-usdt')) $('#market-usdt').textContent=p.market?.usdtUsd?Number(p.market.usdtUsd).toFixed(4)+' USD':'—';
      if($('#market-usdt-toman')) $('#market-usdt-toman').textContent=p.market?.usdtToman?n(p.market.usdtToman)+' تومان':'—';
      if($('#market-demand')) $('#market-demand').textContent=(p.factors?.demand??0)+'%';
    }catch{}
  }
  async function stopCamera(){
    if(scanTimer){clearInterval(scanTimer);scanTimer=null;}
    if(scannerStream){scannerStream.getTracks().forEach(t=>t.stop());scannerStream=null;}
    $('#scanner-video')?.pause(); $('#scanner-video').srcObject=null;
    $('#scanner-camera-wrap')?.classList.add('hidden');
  }
  async function startCamera(){
    if(!('BarcodeDetector' in window)){toast('این مرورگر BarcodeDetector ندارد؛ شماره ۱۲ رقمی را دستی وارد کنید.','error');return;}
    try{
      const supported=await BarcodeDetector.getSupportedFormats?.()||[];
      const formats=['qr_code','code_128','ean_13','ean_8','code_39','code_93','itf','upc_a','upc_e'].filter(x=>!supported.length||supported.includes(x));
      const detector=new BarcodeDetector({formats});
      scannerStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
      const video=$('#scanner-video'); video.srcObject=scannerStream; await video.play();
      $('#scanner-camera-wrap')?.classList.remove('hidden');
      $('#scanner-camera-status').textContent='در حال جستجوی بارکد…';
      scanTimer=setInterval(async()=>{
        try{
          const codes=await detector.detect(video);
          const value=codes?.[0]?.rawValue?.replace(/[\s-]/g,'');
          if(value&&/^\d{12}$/.test(value)){
            $('#scan-card-number').value=value;await stopCamera();doScanLookup();
          }
        }catch{}
      },250);
    }catch(e){toast('دسترسی دوربین ممکن نشد. روی localhost یا شبکه محلی و با اجازه مرورگر امتحان کنید.','error');}
  }
  document.addEventListener('DOMContentLoaded',()=>{
    $('#scan-camera-btn')?.addEventListener('click',startCamera);
    $('#scan-camera-stop')?.addEventListener('click',stopCamera);
    $('#scan-card-number')?.setAttribute('maxlength','12');
    refreshMarket();
    setInterval(refreshMarket,30000);
  });
  window.ILI_ENH={refreshMarket,stopCamera};
})();
