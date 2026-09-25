/* ─────────────────────────────────────────────────────────────
   BWR promo reel #3 — "Chaque balade te rapporte des points"
   Angle: gamification (badges + XP + leaderboard), gold theme.
   Distinct from reel #1 (3 sentiers) and #2 (trace ta boucle).
   ───────────────────────────────────────────────────────────── */

// A real loop through the forest — the "balade" that earns the points.
const ROUTE = [[49.40450,2.81700],[49.40980,2.82640],[49.41260,2.83880],[49.40890,2.84970],
  [49.40180,2.85320],[49.39520,2.84810],[49.39410,2.83560],[49.39880,2.82480],
  [49.40450,2.81700]];

// Badges that "unlock" as the route draws.
const BADGES = [
  { at:0.20, ic:'🥾', name:'Premier pas',      sub:'Première balade',     xp:'+20' },
  { at:0.55, ic:'🌳', name:'Explorateur',      sub:'10 km cette semaine', xp:'+40' },
  { at:0.88, ic:'🏆', name:'Gardien de la forêt', sub:'Top du classement', xp:'+60' },
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
let abort=false, drawn=[];

// Bare capture mode for the headless recorder (full-bleed, no controls).
if(location.search.includes('bare')) document.body.classList.add('bare');

function showOnly(id){
  ['L-hook-top','L-hook','L-board','L-cta'].forEach(x=>$('#'+x).classList.add('hidden'));
  if(id) $('#'+id).classList.remove('hidden');
}
function fadeIn(el,delay=0){ setTimeout(()=>el.classList.add('in'),delay); }
function resetFades(){ document.querySelectorAll('.fade').forEach(e=>e.classList.remove('in')); }

// progressively draw the route; fire badge unlocks + XP at thresholds
async function drawRoute(dur){
  const line = L.polyline([],{color:'#fbbf24',weight:7,opacity:.96,lineJoin:'round',lineCap:'round'}).addTo(map);
  const glow = L.polyline([],{color:'#fffbe6',weight:14,opacity:.20,lineJoin:'round',lineCap:'round'}).addTo(map);
  drawn.push(line,glow);
  const dense=[];
  for(let i=0;i<ROUTE.length-1;i++){
    const a=ROUTE[i],b=ROUTE[i+1],steps=16;
    for(let s=0;s<steps;s++) dense.push([a[0]+(b[0]-a[0])*s/steps, a[1]+(b[1]-a[1])*s/steps]);
  }
  dense.push(ROUTE[ROUTE.length-1]);
  let fired=BADGES.map(()=>false);
  const start=performance.now();
  return new Promise(res=>{
    function frame(now){
      if(abort){return res();}
      const p=Math.min(1,(now-start)/dur);
      const n=Math.max(2,Math.floor(p*dense.length));
      const slice=dense.slice(0,n);
      line.setLatLngs(slice); glow.setLatLngs(slice);
      BADGES.forEach((b,i)=>{ if(!fired[i] && p>=b.at){ fired[i]=true; unlockBadge(b); } });
      if(p<1) requestAnimationFrame(frame); else res();
    }
    requestAnimationFrame(frame);
  });
}

// XP bar — value/target kept coherent so the number always matches the fill.
const XP_TARGET = BADGES.reduce((s,b)=>s+(parseInt(b.xp.replace('+',''))||0),0); // 120
let xpVal=0, xpLevel=3;
function renderXP(){
  $('#xpFill').style.width=Math.min(100, xpVal/XP_TARGET*100)+'%';
  $('#xpVal').textContent=xpVal+' / '+XP_TARGET+' XP';
  $('#xpLvl').textContent=xpLevel;
}
function resetXP(){ xpVal=0; xpLevel=3; renderXP(); }
function unlockBadge(b){
  const el=document.createElement('div');
  el.className='badge pop';
  el.innerHTML=`<div class="ic">${b.ic}</div>
    <div class="tx"><b>${b.name}</b><span>${b.sub}</span></div>
    <div class="plus">${b.xp}</div>`;
  $('#badges').appendChild(el);
  xpVal += parseInt(b.xp.replace('+',''))||0;
  if(xpVal>=XP_TARGET) xpLevel=4;           // hit the target → level up
  renderXP();
  $('#xpwrap').classList.add('on');
  $('#xpFill').classList.remove('beat'); void $('#xpFill').offsetWidth; $('#xpFill').classList.add('beat');
}
function clearBadges(){ $('#badges').innerHTML=''; }

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
const TOTAL = 23000;
async function play(){
  abort=false; resetFades(); $('#prog').style.width='0';
  map.invalidateSize();
  drawn.forEach(l=>map.removeLayer(l)); drawn=[];
  clearBadges(); $('#xpwrap').classList.remove('on'); resetXP();
  ['col1','col2','col3'].forEach(c=>$('#'+c).classList.remove('in'));
  runProgress(TOTAL);

  // SCENE 0 — hook (0–4.2s)
  map.flyTo([49.40,2.835],13,{duration:1.2});
  showOnly('L-hook'); $('#hk-main').innerHTML=''; $('#hk-sub').textContent='';
  $('#L-hook-top').classList.remove('hidden');
  fadeIn($('#hk-kick'),100);
  await sleep(700); if(abort)return;
  $('#hk-main').innerHTML='Et si chaque<br>balade…';
  fadeIn($('#hk-main'),50);
  await sleep(1700); if(abort)return;
  resetFades(); await sleep(350);
  $('#hk-main').innerHTML='…te rapportait<br>des <span class="num">points</span> ?';
  $('#hk-main').classList.add('beat');
  fadeIn($('#hk-main'),30);
  $('#hk-sub').textContent='Marche · Cours · Pédale';
  fadeIn($('#hk-sub'),350);
  await sleep(1700); if(abort)return;
  $('#L-hook-top').classList.add('hidden');

  // SCENE 1 — earn it: draw the route, unlock badges, fill XP (4.2–15s)
  showOnly(null);
  map.flyToBounds(L.latLngBounds(ROUTE).pad(0.28),{duration:1.4});
  await sleep(1300); if(abort)return;
  await drawRoute(8200); if(abort)return;
  await sleep(900); if(abort)return;

  // SCENE 2 — leaderboard podium (≈16–20.5s)
  clearBadges(); $('#xpwrap').classList.remove('on');
  resetFades(); showOnly('L-board');
  fadeIn($('#bd-title'),120); fadeIn($('#bd-sub'),360);
  await sleep(550); if(abort)return;
  $('#col2').classList.add('in');
  await sleep(280); $('#col1').classList.add('in');
  await sleep(280); $('#col3').classList.add('in');
  $('#bd-title').classList.add('beat');
  await sleep(3000); if(abort)return;

  // SCENE 3 — CTA (last ~2.5s)
  resetFades(); showOnly('L-cta');
  fadeIn($('#cta-logo'),150);
  fadeIn($('#cta-btn'),650);
  fadeIn($('#cta-url'),950);
  $('#cta-logo').classList.add('beat');
}

// ── generated soundtrack (royalty-free, synthesized live, ~23s) ──
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

  const bpm=124, beat=60/bpm, bars=12;      // ~23.2s
  const end=t0+bars*4*beat;
  const N={A2:110,E3:164.81,A3:220,C4:261.63,D4:293.66,E4:329.63,
           F4:349.23,G4:392,A4:440,C5:523.25,D5:587.33,E5:659.25,F5:698.46};
  const arp =[N.A3,N.C4,N.E4,N.G4,N.A4,N.G4,N.E4,N.C4];
  const lead=[N.A4,N.C5,N.E5,N.F5,N.E5,N.C5,N.A4,N.G4];
  const bass=[N.A2,N.A2,N.F4/4,N.E3];

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
  // a bright "ding" to punctuate each badge unlock feel (bars 4,6,8)
  function chime(start){
    [N.C5,N.E5,N.G4].forEach((f,i)=>tone(f,start+i*0.06,0.6,'sine',0.12,0));
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
    if(bar===4||bar===6||bar===8) chime(bs);
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
    a.download='bwr-reel-defis'+(mime.includes('mp4')?'.mp4':'.webm');
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
