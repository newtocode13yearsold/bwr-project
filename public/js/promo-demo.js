/* ─────────────────────────────────────────────────────────────
   BWR promo reel #2 — "Trace ta boucle en 10 s"
   A cinematic, scripted demo of the route planner over a real map.
   ───────────────────────────────────────────────────────────── */

// A pretty forest loop near the heart of Compiègne forest. [lat,lon], closed.
const START = [49.3705,2.8950];
const LOOP = [
  [49.3705,2.8950],[49.3742,2.8988],[49.3763,2.9058],[49.3737,2.9121],
  [49.3690,2.9138],[49.3648,2.9092],[49.3643,2.9013],[49.3672,2.8958],[49.3705,2.8950]
];
const RESULT = { km:'8,2 km', dur:'2 h 05', up:'+120 m' };

const map = L.map('map',{zoomControl:false,attributionControl:true,
  fadeAnimation:true,zoomAnimation:true,inertia:false,keyboard:false,
  dragging:false,scrollWheelZoom:false,doubleClickZoom:false,touchZoom:false})
  .setView([49.37,2.90],12);

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',{
  maxZoom:19, subdomains:'abcd',
  attribution:'© OpenStreetMap · © CARTO'
}).addTo(map);

// ── helpers ────────────────────────────────────────────────
const $ = s=>document.querySelector(s);
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
let abort=false;

function showOnly(id){
  ['L-hook-top','L-hook','L-stat','L-cta'].forEach(x=>$('#'+x).classList.add('hidden'));
  if(id) $('#'+id).classList.remove('hidden');
}
function fadeIn(el,delay=0){ setTimeout(()=>el.classList.add('in'),delay); }
function resetFades(){ document.querySelectorAll('.fade').forEach(e=>e.classList.remove('in')); }

// animate a "tap" + selection on a planner option
async function tapSelect(id,wait=650){
  if(abort)return;
  const el=$('#'+id);
  el.classList.add('sel','tap');
  setTimeout(()=>el.classList.remove('tap'),550);
  await sleep(wait);
}

// draw the loop progressively
async function drawLoop(dur){
  const line = L.polyline([],{color:'#22c55e',weight:7,opacity:.96,
    lineJoin:'round',lineCap:'round'}).addTo(map);
  const glow = L.polyline([],{color:'#ffffff',weight:13,opacity:.18,
    lineJoin:'round',lineCap:'round'}).addTo(map);
  const dense=[];
  for(let i=0;i<LOOP.length-1;i++){
    const a=LOOP[i],b=LOOP[i+1],steps=16;
    for(let s=0;s<steps;s++) dense.push([a[0]+(b[0]-a[0])*s/steps, a[1]+(b[1]-a[1])*s/steps]);
  }
  dense.push(LOOP[LOOP.length-1]);
  const start=performance.now();
  return new Promise(res=>{
    function frame(now){
      if(abort){map.removeLayer(line);map.removeLayer(glow);return res(line);}
      const p=Math.min(1,(now-start)/dur);
      const n=Math.max(2,Math.floor(p*dense.length));
      const slice=dense.slice(0,n);
      line.setLatLngs(slice); glow.setLatLngs(slice);
      if(p<1) requestAnimationFrame(frame); else res(line);
    }
    requestAnimationFrame(frame);
  });
}

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

let drawn=[], startMarker=null;
function clearStage(){
  drawn.forEach(l=>map.removeLayer(l)); drawn=[];
  if(startMarker){ map.removeLayer(startMarker); startMarker=null; }
  $('#panel').classList.remove('in');
  document.querySelectorAll('.opt').forEach(o=>o.classList.remove('sel','tap'));
  $('#genBtn').classList.remove('tap');
}

// ── the timeline (≈22 s) ───────────────────────────────────
const TOTAL = 22000;
async function play(){
  abort=false; resetFades(); $('#prog').style.width='0';
  map.invalidateSize(); clearStage();
  runProgress(TOTAL);

  // SCENE 0 — hook (0–4.4s)
  map.flyTo([49.37,2.905],12,{duration:1.2});
  showOnly('L-hook'); $('#hk-main').innerHTML=''; $('#hk-sub').textContent='';
  $('#L-hook-top').classList.remove('hidden');
  fadeIn($('#hk-kick'),100);
  await sleep(700); if(abort)return;
  $('#hk-main').innerHTML='Marre de<br>tourner en rond ?';
  fadeIn($('#hk-main'),50);
  await sleep(1800); if(abort)return;
  resetFades();
  await sleep(350);
  $('#hk-main').innerHTML='Ta boucle en<br><span class="num">10 secondes</span>';
  $('#hk-main').classList.add('beat');
  fadeIn($('#hk-main'),30);
  $('#hk-sub').textContent='à pied ou à vélo 🥾🚲';
  fadeIn($('#hk-sub'),350);
  await sleep(1500); if(abort)return;
  $('#L-hook-top').classList.add('hidden');
  showOnly(null);

  // SCENE 1 — drop start point (4.4–6.4s)
  map.flyTo(START,13.6,{duration:1.4});
  await sleep(900); if(abort)return;
  startMarker = L.marker(START,{icon:L.divIcon({className:'',html:'<div class="gps"></div>',iconSize:[18,18],iconAnchor:[9,9]})}).addTo(map);
  await sleep(950); if(abort)return;

  // SCENE 2 — planner panel + selections (6.4–11.4s)
  $('#panel').classList.add('in');
  await sleep(900); if(abort)return;
  await tapSelect('o-loop',850);
  await tapSelect('o-8',850);
  await tapSelect('o-easy',900);

  // SCENE 3 — generate (11.4–12.4s)
  if(abort)return;
  $('#genBtn').classList.add('tap');
  await sleep(950); if(abort)return;
  $('#panel').classList.remove('in');
  await sleep(450); if(abort)return;

  // SCENE 4 — draw the loop (12.8–17s)
  map.flyToBounds(L.latLngBounds(LOOP).pad(0.28),{duration:1.2});
  await sleep(700); if(abort)return;
  const line=await drawLoop(3000);
  drawn.push(line);
  await sleep(400); if(abort)return;

  // SCENE 5 — stat card (17–19.4s)
  $('#scard').innerHTML=`<div class="title">Itinéraire prêt ✅</div>
    <div class="stats">
      <div class="stat"><span class="v">${RESULT.km}</span><span class="l">Distance</span></div>
      <div class="stat"><span class="v">${RESULT.dur}</span><span class="l">Durée</span></div>
      <div class="stat"><span class="v">${RESULT.up}</span><span class="l">Dénivelé</span></div>
    </div>`;
  $('#scard').classList.remove('pop'); void $('#scard').offsetWidth; $('#scard').classList.add('pop');
  showOnly('L-stat');
  await sleep(2300); if(abort)return;

  // SCENE 6 — CTA (19.4–22s)
  map.flyToBounds(L.latLngBounds(LOOP).pad(0.15),{duration:1.2});
  resetFades(); showOnly('L-cta');
  fadeIn($('#cta-logo'),150);
  fadeIn($('#cta-btn'),650);
  fadeIn($('#cta-url'),950);
  $('#cta-logo').classList.add('beat');
}

// ── generated soundtrack (royalty-free, synthesized live, 22s) ──
let audioCtx=null, musicStop=null;
function startMusic(){
  stopMusic();
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC) return;
  const ac=new AC(); audioCtx=ac;
  const master=ac.createGain();
  const t0=ac.currentTime+0.06;
  master.gain.setValueAtTime(0,t0);
  master.gain.linearRampToValueAtTime(0.85,t0+1.1);
  master.connect(ac.destination);

  const bpm=120, beat=60/bpm, bars=11;      // 11*4*0.5 = 22.0s
  const end=t0+bars*4*beat;
  const N={A2:110,E3:164.81,A3:220,C4:261.63,D4:293.66,E4:329.63,
           G4:392,A4:440,C5:523.25,D5:587.33,E5:659.25};
  const arp =[N.A3,N.C4,N.E4,N.G4,N.A4,N.G4,N.E4,N.C4];
  const lead=[N.A4,N.C5,N.E5,N.D5,N.C5,N.A4,N.G4,N.A4];
  const bass=[N.A2,N.A2,N.E3,N.E3];

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
    o.frequency.setValueAtTime(150,start);
    o.frequency.exponentialRampToValueAtTime(45,start+0.12);
    g.gain.setValueAtTime(0.95,start);
    g.gain.exponentialRampToValueAtTime(0.001,start+0.2);
    o.connect(g); g.connect(master); o.start(start); o.stop(start+0.22);
  }
  function hat(start){
    const buf=ac.createBuffer(1,(ac.sampleRate*0.05)|0,ac.sampleRate);
    const d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,2);
    const b=ac.createBufferSource(); b.buffer=buf;
    const hp=ac.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=7000;
    const g=ac.createGain(); g.gain.value=0.16;
    b.connect(hp); hp.connect(g); g.connect(master); b.start(start);
  }
  for(let bar=0;bar<bars;bar++){
    const bs=t0+bar*4*beat;
    for(let i=0;i<8;i++) tone(arp[i%arp.length],bs+i*0.5*beat,0.45*beat,'triangle',0.15,i%2?0.25:-0.25);
    if(bar>=2 && bar<bars-1){
      for(let b=0;b<4;b++){ kick(bs+b*beat); hat(bs+b*beat+0.5*beat); }
      tone(bass[bar%4],bs,2*beat,'sawtooth',0.20,0);
      tone(bass[(bar+1)%4],bs+2*beat,2*beat,'sawtooth',0.20,0);
    }
    if(bar>=4 && bar<bars-1)
      for(let i=0;i<8;i+=2) tone(lead[(bar*2+i/2)%lead.length],bs+i*0.5*beat,0.9*beat,'square',0.10,0.15);
    if(bar===bars-1) [N.A3,N.C4,N.E4,N.A4].forEach(f=>tone(f,bs,2.4,'triangle',0.18,0));
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
  startSound();
  play();
});
$('#replay').addEventListener('click',async()=>{
  abort=true; stopMusic(); await sleep(60); abort=false;
  clearStage();
  startSound();
  play();
});

// ── one-click recorder → downloads a video file ──────────────
$('#rec').addEventListener('click',async()=>{
  if(!navigator.mediaDevices?.getDisplayMedia){ alert('Ton navigateur ne supporte pas l’enregistrement. Utilise un screen-recorder.'); return; }
  let stream;
  try{
    stream=await navigator.mediaDevices.getDisplayMedia({
      video:{frameRate:30}, audio:true, preferCurrentTab:true
    });
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
    a.download='bwr-reel-trace-ta-boucle'+(mime.includes('mp4')?'.mp4':'.webm');
    document.body.appendChild(a); a.click(); a.remove();
    stream.getTracks().forEach(t=>t.stop());
    $('#rec').textContent='⏺ Enregistrer la vidéo';
  };
  $('#rec').textContent='● Enregistrement…';
  $('#gate').style.display='none'; map.invalidateSize();
  abort=true; stopMusic(); await sleep(80); abort=false;
  clearStage();
  rec.start(); startSound(); play();
  setTimeout(()=>{ try{ rec.stop(); }catch(e){} }, TOTAL+700);
});
$('#fs').addEventListener('click',()=>{
  const s=$('#stage');
  if(!document.fullscreenElement) s.requestFullscreen?.(); else document.exitFullscreen?.();
});

let audioEl=null;
$('#audio').addEventListener('change',e=>{
  const f=e.target.files[0]; if(!f)return;
  if(audioEl){ audioEl.pause(); }
  audioEl=new Audio(URL.createObjectURL(f)); audioEl.loop=false;
});

window.addEventListener('resize',()=>map.invalidateSize());
setTimeout(()=>map.invalidateSize(),200);
