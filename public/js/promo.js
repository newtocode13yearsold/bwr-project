/* ─────────────────────────────────────────────────────────────
   BWR promo reel — data-driven cinematic timeline over a real map
   ───────────────────────────────────────────────────────────── */

// 3 hidden trails — built from REAL named carrefours of the forest.
// coords arrays are [lat,lon] waypoints; the polyline is drawn progressively.
const TRAILS = [
  {
    // Obscure cluster around Carrefour du Cheval Noir — rarely walked.
    idx:'01', name:'Le Cheval Noir', tag:'La légende oubliée',
    km:'3,4 km', diff:'easy', diffLabel:'Facile',
    color:'#22c55e',
    pts:[[49.36470,2.88834],[49.36130,2.88477],[49.35975,2.88311],[49.35945,2.88705],
         [49.35903,2.89469],[49.35557,2.89847],[49.36100,2.89300],[49.36470,2.88834]]
  },
  {
    // Obscure cluster around Carrefour du Saut du Cerf — quiet eastern futaie.
    idx:'02', name:'Le Saut du Cerf', tag:'Là où passent les cerfs',
    km:'4,1 km', diff:'medium', diffLabel:'Moyen',
    color:'#f97316',
    pts:[[49.39384,2.90070],[49.39491,2.91183],[49.39808,2.90914],[49.39800,2.89910],
         [49.39798,2.89518],[49.39550,2.89700],[49.39384,2.90070]]
  },
  {
    // Deep-south cluster around Carrefour des Vestales — the forest's wild, unvisited edge.
    idx:'03', name:'Les Vestales', tag:'Le sud sauvage',
    km:'5,2 km', diff:'hard', diffLabel:'Difficile',
    color:'#ef4444',
    pts:[[49.31635,2.89833],[49.32092,2.89269],[49.32615,2.90771],[49.33121,2.88691],
         [49.32781,2.88459],[49.32299,2.88125],[49.31635,2.89833]]
  }
];

const map = L.map('map',{zoomControl:false,attributionControl:true,
  fadeAnimation:true,zoomAnimation:true,inertia:false,keyboard:false,
  dragging:false,scrollWheelZoom:false,doubleClickZoom:false,touchZoom:false})
  .setView([49.37,2.90],12);

// Forest-toned basemap (Carto Voyager = clean & green-friendly)
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',{
  maxZoom:19, subdomains:'abcd',
  attribution:'© OpenStreetMap · © CARTO'
}).addTo(map);

// ── helpers ────────────────────────────────────────────────
const $ = s=>document.querySelector(s);
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
let abort=false;

function showOnly(id){
  ['L-hook-top','L-hook','L-trail','L-cta'].forEach(x=>$('#'+x).classList.add('hidden'));
  if(id) $('#'+id).classList.remove('hidden');
}
function fadeIn(el,delay=0){ setTimeout(()=>el.classList.add('in'),delay); }
function resetFades(){ document.querySelectorAll('.fade').forEach(e=>e.classList.remove('in')); }

// draw a polyline progressively, returns when done
async function drawTrail(t,dur){
  const line = L.polyline([],{color:t.color,weight:7,opacity:.95,
    lineJoin:'round',lineCap:'round'}).addTo(map);
  const glow = L.polyline([],{color:'#ffffff',weight:13,opacity:.18,
    lineJoin:'round',lineCap:'round'}).addTo(map);
  // densify waypoints for smooth growth
  const dense=[];
  for(let i=0;i<t.pts.length-1;i++){
    const a=t.pts[i],b=t.pts[i+1],steps=14;
    for(let s=0;s<steps;s++){
      dense.push([a[0]+(b[0]-a[0])*s/steps, a[1]+(b[1]-a[1])*s/steps]);
    }
  }
  dense.push(t.pts[t.pts.length-1]);
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

function buildCard(t){
  return `<div class="idx">SENTIER N°${t.idx}</div>
    <div class="tname">${t.name}</div>
    <div class="ttag">${t.tag}</div>
    <div class="chips">
      <span class="chip km">📍 ${t.km}</span>
      <span class="chip ${t.diff}">● ${t.diffLabel}</span>
    </div>`;
}

function flyTrail(t,dur){
  const b=L.latLngBounds(t.pts).pad(0.35);
  map.flyToBounds(b,{duration:dur/1000,easeLinearity:.25});
}

// progress bar over total duration
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

// ── the timeline ───────────────────────────────────────────
const TOTAL = 22000;
async function play(){
  abort=false; resetFades(); $('#prog').style.width='0';
  map.invalidateSize();
  drawn.forEach(l=>map.removeLayer(l)); drawn=[];
  runProgress(TOTAL);

  // SCENE 0 — hook (0–4.2s)
  map.flyTo([49.37,2.90],12,{duration:1.2});
  showOnly('L-hook'); $('#hk-main').innerHTML=''; $('#hk-sub').textContent='';
  $('#L-hook-top').classList.remove('hidden');
  fadeIn($('#hk-kick'),100);
  await sleep(700); if(abort)return;
  $('#hk-main').innerHTML='Tu crois<br>tout connaître ?';
  fadeIn($('#hk-main'),50);
  await sleep(1700); if(abort)return;
  resetFades();
  await sleep(350);
  $('#hk-main').innerHTML='<span class="num">3</span> sentiers<br>cachés';
  $('#hk-main').classList.add('beat');
  fadeIn($('#hk-main'),30);
  $('#hk-sub').textContent='que personne ne te montre';
  fadeIn($('#hk-sub'),350);
  await sleep(1700); if(abort)return;
  $('#L-hook-top').classList.add('hidden');

  // SCENES 1–3 — the trails
  for(const t of TRAILS){
    if(abort)return;
    showOnly(null);
    flyTrail(t,1600);
    await sleep(1500); if(abort)return;
    // reveal card
    $('#tcard').innerHTML=buildCard(t);
    $('#tcard').classList.remove('pop'); void $('#tcard').offsetWidth; $('#tcard').classList.add('pop');
    showOnly('L-trail');
    const line=await drawTrail(t,3000); // ~3s draw
    drawn.push(line);
    await sleep(900); if(abort)return;
  }

  // SCENE 4 — CTA (last ~3s)
  if(abort)return;
  map.flyToBounds(L.latLngBounds(TRAILS.flatMap(t=>t.pts)).pad(0.2),{duration:1.4});
  resetFades(); showOnly('L-cta');
  fadeIn($('#cta-logo'),150);
  fadeIn($('#cta-btn'),650);
  fadeIn($('#cta-url'),950);
  $('#cta-logo').classList.add('beat');
}

let drawn=[];

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
// play user's own track if loaded, otherwise the generated soundtrack
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
  drawn.forEach(l=>map.removeLayer(l)); drawn=[];
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
  }catch(e){ return; } // user cancelled
  const mime = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4'
            : MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus'
            : 'video/webm';
  const rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:9000000});
  const chunks=[]; rec.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
  rec.onstop=()=>{
    const blob=new Blob(chunks,{type:mime});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='bwr-reel-3-sentiers'+(mime.includes('mp4')?'.mp4':'.webm');
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

// optional preview audio (NOT embedded in any export — local preview only)
let audioEl=null;
$('#audio').addEventListener('change',e=>{
  const f=e.target.files[0]; if(!f)return;
  if(audioEl){ audioEl.pause(); }
  audioEl=new Audio(URL.createObjectURL(f)); audioEl.loop=false;
});

// keep map sized to the stage
window.addEventListener('resize',()=>map.invalidateSize());
setTimeout(()=>map.invalidateSize(),200);
