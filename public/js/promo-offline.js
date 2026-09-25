/* ─────────────────────────────────────────────────────────────
   BWR promo reel #4 — "Ta forêt, même sans réseau"
   Angle: offline maps + live GPS. Electric-cyan theme.
   Distinct from #1 (3 sentiers), #2 (boucle), #3 (défis/classement).
   The signal dies on the "drop" (~4 s), then the GPS dot keeps
   tracking along the route while the map stays fully usable.
   ───────────────────────────────────────────────────────────── */

// A real hiking route through the forest — the GPS dot follows it offline.
const ROUTE = [[49.40450,2.81700],[49.40980,2.82640],[49.41260,2.83880],[49.40890,2.84970],
  [49.40180,2.85320],[49.39520,2.84810],[49.39410,2.83560],[49.39880,2.82480],
  [49.40450,2.81700]];

// Feature chips that pop while the dot travels.
const CHIPS = [
  { at:0.22, ic:'📥', tx:'Carte hors-ligne' },
  { at:0.55, ic:'📍', tx:'GPS en direct' },
  { at:0.85, ic:'🧭', tx:'Zéro perte de signal' },
];

const map = L.map('map',{zoomControl:false,attributionControl:true,
  fadeAnimation:true,zoomAnimation:true,inertia:false,keyboard:false,
  dragging:false,scrollWheelZoom:false,doubleClickZoom:false,touchZoom:false})
  .setView([49.40,2.835],13);

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',{
  maxZoom:19, subdomains:'abcd',
  attribution:'© OpenStreetMap · © CARTO'
}).addTo(map);

const $ = s=>document.querySelector(s);
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
let abort=false, drawn=[], gpsDot=null, gpsHalo=null;

// Bare capture mode for the headless recorder (full-bleed, no controls).
if(location.search.includes('bare')) document.body.classList.add('bare');

function showOnly(id){
  ['L-hook-top','L-hook','L-recap','L-cta'].forEach(x=>$('#'+x).classList.add('hidden'));
  if(id) $('#'+id).classList.remove('hidden');
}
function fadeIn(el,delay=0){ setTimeout(()=>el.classList.add('in'),delay); }
function resetFades(){ document.querySelectorAll('.fade').forEach(e=>e.classList.remove('in')); }

// densify the route once so both the drawn trail and the moving dot are smooth
function densify(){
  const dense=[];
  for(let i=0;i<ROUTE.length-1;i++){
    const a=ROUTE[i],b=ROUTE[i+1],steps=18;
    for(let s=0;s<steps;s++) dense.push([a[0]+(b[0]-a[0])*s/steps, a[1]+(b[1]-a[1])*s/steps]);
  }
  dense.push(ROUTE[ROUTE.length-1]);
  return dense;
}

// draw the completed trail + walk a live "GPS" dot along it; pop chips at thresholds
async function trackRoute(dur){
  const dense=densify();
  const trail = L.polyline([],{color:'#22d3ee',weight:7,opacity:.95,lineJoin:'round',lineCap:'round',dashArray:'2 10'}).addTo(map);
  const glow  = L.polyline([],{color:'#a5f3fc',weight:14,opacity:.16,lineJoin:'round',lineCap:'round'}).addTo(map);
  gpsHalo = L.circleMarker(dense[0],{radius:16,color:'#22d3ee',weight:0,fillColor:'#22d3ee',fillOpacity:.22}).addTo(map);
  gpsDot  = L.circleMarker(dense[0],{radius:8,color:'#fff',weight:3,fillColor:'#38bdf8',fillOpacity:1}).addTo(map);
  drawn.push(trail,glow,gpsHalo,gpsDot);

  let fired=CHIPS.map(()=>false);
  const start=performance.now();
  return new Promise(res=>{
    function frame(now){
      if(abort){return res();}
      const p=Math.min(1,(now-start)/dur);
      const n=Math.max(2,Math.floor(p*dense.length));
      const slice=dense.slice(0,n);
      trail.setLatLngs(slice); glow.setLatLngs(slice);
      const head=slice[slice.length-1];
      gpsDot.setLatLng(head); gpsHalo.setLatLng(head);
      CHIPS.forEach((c,i)=>{ if(!fired[i] && p>=c.at){ fired[i]=true; popChip(c); } });
      if(p<1) requestAnimationFrame(frame); else res();
    }
    requestAnimationFrame(frame);
  });
}

function popChip(c){
  const el=document.createElement('div');
  el.className='chip pop';
  el.innerHTML=`<div class="ic">${c.ic}</div><div class="tx">${c.tx}</div>`;
  $('#chips').appendChild(el);
}
function clearChips(){ $('#chips').innerHTML=''; }

// signal indicator helpers
function setSignal(state){ // 'on' (4G) | 'dead' (no signal)
  const s=$('#signal');
  s.classList.add('on');
  if(state==='dead'){ s.classList.add('dead'); s.querySelector('.lbl').textContent='Hors-ligne'; s.classList.add('shake'); }
  else{ s.classList.remove('dead'); s.querySelector('.lbl').textContent='4G'; }
}
function hideSignal(){ $('#signal').classList.remove('on','dead','shake'); }

// progress bar
let progRAF;
function runProgress(total){
  const el=$('#prog'); const start=performance.now();
  (function tick(now){
    if(abort) return;
    const p=Math.min(1,(now-start)/total);
    el.style.width=(p*100)+'%';
    if(p<1) progRAF=requestAnimationFrame(tick);
  })(performance.now());
}

// ── timeline ───────────────────────────────────────────────
const TOTAL = 22000;
async function play(){
  abort=false; resetFades(); $('#prog').style.width='0';
  map.invalidateSize();
  drawn.forEach(l=>map.removeLayer(l)); drawn=[];
  clearChips(); hideSignal(); $('#map').classList.remove('offline');
  ['rc1','rc2','rc3'].forEach(c=>$('#'+c).classList.remove('in'));
  runProgress(TOTAL);

  // SCENE 0 — hook (0–4s): full signal, everything looks normal
  map.flyTo([49.40,2.835],13,{duration:1.2});
  showOnly('L-hook'); $('#hk-main').innerHTML=''; $('#hk-sub').textContent='';
  $('#L-hook-top').classList.remove('hidden');
  fadeIn($('#hk-kick'),100);
  setTimeout(()=>setSignal('on'),300);
  await sleep(700); if(abort)return;
  $('#hk-main').innerHTML='Plein cœur<br>de la forêt…';
  fadeIn($('#hk-main'),50);
  await sleep(1600); if(abort)return;
  resetFades(); await sleep(300);

  // THE DROP (~4s): signal dies, flash hit, map desaturates
  $('#flash').classList.remove('hit'); void $('#flash').offsetWidth; $('#flash').classList.add('hit');
  setSignal('dead'); $('#map').classList.add('offline');
  $('#hk-main').innerHTML='…et plus<br>de <span class="num">réseau.</span>';
  $('#hk-main').classList.add('beat');
  fadeIn($('#hk-main'),30);
  $('#hk-sub').textContent='Avec BWR, aucun souci.';
  fadeIn($('#hk-sub'),550);
  await sleep(1700); if(abort)return;
  $('#L-hook-top').classList.add('hidden');

  // SCENE 1 — offline tracking: dot walks the route, chips pop (4–14s)
  showOnly(null);
  $('#map').classList.remove('offline'); // map is fully usable offline → bring it back to life
  map.flyToBounds(L.latLngBounds(ROUTE).pad(0.28),{duration:1.4});
  await sleep(1300); if(abort)return;
  await trackRoute(7600); if(abort)return;
  await sleep(700); if(abort)return;

  // SCENE 2 — recap: three reasons (≈15–19.5s)
  clearChips(); hideSignal();
  resetFades(); showOnly('L-recap');
  fadeIn($('#rc-title'),120);
  await sleep(500); if(abort)return;
  $('#rc1').classList.add('in');
  await sleep(320); $('#rc2').classList.add('in');
  await sleep(320); $('#rc3').classList.add('in');
  $('#rc-title').classList.add('beat');
  await sleep(2600); if(abort)return;

  // SCENE 3 — CTA (last ~2.5s)
  resetFades(); showOnly('L-cta');
  fadeIn($('#cta-logo'),150);
  fadeIn($('#cta-btn'),650);
  fadeIn($('#cta-url'),950);
  $('#cta-logo').classList.add('beat');
}

// ── generated soundtrack (royalty-free preview, synthesized live, ~22s) ──
// This is only a PREVIEW so the page is fun to watch locally. The exported
// video (make-offline.mjs) muxes the purchased EDM track instead.
let audioCtx=null, musicStop=null;
function startMusic(){
  stopMusic();
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC) return;
  const ac=new AC(); audioCtx=ac;
  const master=ac.createGain();
  const t0=ac.currentTime+0.06;
  master.gain.setValueAtTime(0,t0);
  master.gain.linearRampToValueAtTime(0.85,t0+1.0);
  master.connect(ac.destination);

  const bpm=128, beat=60/bpm, bars=12;      // ~22.5s
  const end=t0+bars*4*beat;
  const N={A2:110,C3:130.81,E3:164.81,A3:220,C4:261.63,D4:293.66,E4:329.63,
           G4:392,A4:440,B4:493.88,C5:523.25,D5:587.33,E5:659.25};
  const arp =[N.A3,N.C4,N.E4,N.A4,N.E4,N.C4];
  const lead=[N.E5,N.D5,N.C5,N.B4,N.C5,N.D5,N.E5,N.A4];
  const bass=[N.A2,N.A2,N.C3,N.E3];

  function tone(freq,start,dur,type,gain,pan){
    const o=ac.createOscillator(); o.type=type; o.frequency.setValueAtTime(freq,start);
    const g=ac.createGain();
    g.gain.setValueAtTime(0,start);
    g.gain.linearRampToValueAtTime(gain,start+0.012);
    g.gain.exponentialRampToValueAtTime(0.0001,start+dur);
    let node=g;
    if(pan!==undefined){const p=ac.createStereoPanner();p.pan.value=pan;g.connect(p);node=p;}
    o.connect(g); node.connect(master); o.start(start); o.stop(start+dur+0.05);
  }
  function kick(start){
    const o=ac.createOscillator(),g=ac.createGain();
    o.frequency.setValueAtTime(160,start);
    o.frequency.exponentialRampToValueAtTime(45,start+0.12);
    g.gain.setValueAtTime(0.98,start);
    g.gain.exponentialRampToValueAtTime(0.001,start+0.2);
    o.connect(g); g.connect(master); o.start(start); o.stop(start+0.22);
  }
  function hat(start){
    const buf=ac.createBuffer(1,(ac.sampleRate*0.05)|0,ac.sampleRate);
    const d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,2);
    const b=ac.createBufferSource(); b.buffer=buf;
    const hp=ac.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=7500;
    const g=ac.createGain(); g.gain.value=0.15;
    b.connect(hp); hp.connect(g); g.connect(master); b.start(start);
  }
  // riser + impact to punctuate "the drop" at bar 2 (~3.75 s)
  function riser(start,dur){
    const o=ac.createOscillator(),g=ac.createGain();
    o.type='sawtooth'; o.frequency.setValueAtTime(180,start);
    o.frequency.exponentialRampToValueAtTime(1400,start+dur);
    g.gain.setValueAtTime(0.0001,start);
    g.gain.exponentialRampToValueAtTime(0.14,start+dur);
    g.gain.exponentialRampToValueAtTime(0.0001,start+dur+0.15);
    o.connect(g); g.connect(master); o.start(start); o.stop(start+dur+0.2);
  }
  riser(t0+1.5*beat, 2*beat);
  for(let bar=0;bar<bars;bar++){
    const bs=t0+bar*4*beat;
    for(let i=0;i<8;i++) tone(arp[i%arp.length],bs+i*0.5*beat,0.45*beat,'triangle',0.14,i%2?0.25:-0.25);
    if(bar>=2 && bar<bars-1){                 // the "drop" — beat kicks in at bar 2
      for(let b=0;b<4;b++){ kick(bs+b*beat); hat(bs+b*beat+0.5*beat); }
      tone(bass[bar%4],bs,2*beat,'sawtooth',0.20,0);
      tone(bass[(bar+1)%4],bs+2*beat,2*beat,'sawtooth',0.20,0);
    }
    if(bar>=2 && bar<bars-1)
      for(let i=0;i<8;i+=2) tone(lead[(bar*2+i/2)%lead.length],bs+i*0.5*beat,0.9*beat,'square',0.10,0.15);
    if(bar===bars-1) [N.A3,N.C4,N.E4,N.A4,N.C5].forEach(f=>tone(f,bs,2.6,'triangle',0.18,0));
  }
  master.gain.setValueAtTime(0.85,end-0.7);
  master.gain.linearRampToValueAtTime(0,end+0.3);
  musicStop=()=>{ try{ac.close();}catch(e){} };
}
function stopMusic(){ if(musicStop){musicStop();musicStop=null;} }
function startSound(){
  if(audioEl){ audioEl.currentTime=0; audioEl.play().catch(()=>{}); }
  else startMusic();
}

// ── controls ───────────────────────────────────────────────
$('#playBtn').addEventListener('click',()=>{
  $('#gate').style.display='none';
  map.invalidateSize();
  startSound(); play();
});
$('#replay').addEventListener('click',async()=>{
  abort=true; stopMusic(); await sleep(60); abort=false;
  drawn.forEach(l=>map.removeLayer(l)); drawn=[];
  startSound(); play();
});

// one-click recorder → downloads a video file
$('#rec').addEventListener('click',async()=>{
  if(!navigator.mediaDevices?.getDisplayMedia){ alert('Ton navigateur ne supporte pas l’enregistrement. Utilise un screen-recorder.'); return; }
  let stream;
  try{
    stream=await navigator.mediaDevices.getDisplayMedia({ video:{frameRate:30}, audio:true, preferCurrentTab:true });
  }catch(e){ return; }
  const mime = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4'
            : MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus'
            : 'video/webm';
  const rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:9000000});
  const chunks=[]; rec.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
  rec.onstop=()=>{
    const blob=new Blob(chunks,{type:mime});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='bwr-reel-offline'+(mime.includes('mp4')?'.mp4':'.webm');
    document.body.appendChild(a); a.click(); a.remove();
    stream.getTracks().forEach(t=>t.stop());
    $('#rec').textContent='⏺ Enregistrer la vidéo';
  };
  $('#rec').textContent='● Enregistrement…';
  $('#gate').style.display='none'; map.invalidateSize();
  abort=true; stopMusic(); await sleep(80); abort=false;
  drawn.forEach(l=>map.removeLayer(l)); drawn=[];
  rec.start(); startSound(); play();
  setTimeout(()=>{ try{ rec.stop(); }catch(e){} }, TOTAL+700);
});
$('#fs').addEventListener('click',()=>{
  const s=$('#stage');
  if(!document.fullscreenElement) s.requestFullscreen?.(); else document.exitFullscreen?.();
});

// optional preview audio (local preview only)
let audioEl=null;
$('#audio').addEventListener('change',e=>{
  const f=e.target.files[0]; if(!f)return;
  if(audioEl){ audioEl.pause(); }
  audioEl=new Audio(URL.createObjectURL(f)); audioEl.loop=false;
});

window.addEventListener('resize',()=>map.invalidateSize());
setTimeout(()=>map.invalidateSize(),200);
