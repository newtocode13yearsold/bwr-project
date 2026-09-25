/* ─────────────────────────────────────────────────────────────
   BWR promo reel #5 — hype photo-montage + kinetic typography.
   Brand-new style: no map. Full-bleed b-roll with Ken-Burns on the
   intro, then HARD beat-synced cuts on the drop, neon magenta/violet
   grade, giant slamming text, feature pills. Built around a purchased
   EDM track with a drop at ~3.75 s (aligned by make-hype.mjs).
   ───────────────────────────────────────────────────────────── */

const PHOTOS = ['p01','p02','p03','p04','p05','p06','p07','p08','p09','p10','p11','p12']
  .map(n=>`promo-broll/${n}.jpg`);

const TAGS = ['🗺️ Itinéraires sur-mesure','📴 Carte hors-ligne','🏆 Défis & classement','🚶 🏃 🚴 À toi de jouer'];

const $ = s=>document.querySelector(s);
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
let abort=false, photoEls=[];

if(location.search.includes('bare')) document.body.classList.add('bare');

// preload photos as layered divs
function buildPhotos(){
  const box=$('#photos'); box.innerHTML=''; photoEls=[];
  PHOTOS.forEach(src=>{
    const d=document.createElement('div'); d.className='ph';
    d.style.backgroundImage=`url(${src})`; box.appendChild(d); photoEls.push(d);
    const img=new Image(); img.src=src; // warm the cache
  });
}
let curPhoto=-1;
function showPhoto(i,{fast=false}={}){
  if(curPhoto>=0){ const p=photoEls[curPhoto]; p.classList.remove('show','kb','kbfast','cut'); }
  curPhoto=i%photoEls.length;
  const el=photoEls[curPhoto];
  el.classList.remove('kb','kbfast','cut');
  void el.offsetWidth;
  // NB: never pass '' to classList.add — an empty token throws and aborts play().
  el.classList.add('show');
  if(fast){ el.classList.add('cut','kbfast'); } else { el.classList.add('kb'); }
}

function showOnly(id){
  ['L-hook-top','L-hook','L-cta'].forEach(x=>$('#'+x).classList.add('hidden'));
  if(id) $('#'+id).classList.remove('hidden');
}
function fadeIn(el,delay=0){ setTimeout(()=>el.classList.add('in'),delay); }
function resetFades(){ document.querySelectorAll('.fade').forEach(e=>e.classList.remove('in')); }
function flash(){ const f=$('#flash'); f.classList.remove('hit'); void f.offsetWidth; f.classList.add('hit'); }
function beatPulse(){ const b=$('#beatline'); b.animate([{boxShadow:'inset 0 0 0 4px rgba(255,45,149,.55)',opacity:1},{boxShadow:'inset 0 0 0 4px rgba(255,45,149,0)',opacity:0}],{duration:260,easing:'ease-out'}); }

function addTag(txt){
  const el=document.createElement('div'); el.className='tag pop'; el.textContent=txt;
  $('#tags').appendChild(el);
}
function clearTags(){ $('#tags').innerHTML=''; }

// progress bar
function runProgress(total){
  const el=$('#prog'); const start=performance.now();
  (function tick(now){ if(abort)return; const p=Math.min(1,(now-start)/total);
    el.style.width=(p*100)+'%'; if(p<1) requestAnimationFrame(tick); })(performance.now());
}

// ── timeline — matched to Martin Garrix "Animals" (128 BPM) ──
// Every image swap after the drop lands exactly on a beat at 128 BPM, so when
// the song's drop is lined up with the ~3.75 s mark the cuts hit the kicks.
const BEAT = 60/128;          // 0.46875s  (128 BPM = "Animals")
const BAR  = BEAT*4;          // 1.875s
const TOTAL = 22500;          // 12 bars
const DROP  = Math.round(BAR*2*1000); // 3750ms — song drop lines up here

async function play(){
  abort=false; resetFades(); $('#prog').style.width='0'; clearTags();
  curPhoto=-1; photoEls.forEach(p=>p.classList.remove('show','kb','kbfast','cut'));
  runProgress(TOTAL);

  // SCENE 0 — intro (0 → drop): one slow Ken-Burns photo + kicker
  showPhoto(0,{fast:false});
  showOnly('L-hook-top'); $('#hk-kick').textContent='Forêt de Compiègne';
  fadeIn($('#hk-kick'),120);
  await sleep(1500); if(abort)return;
  // pre-drop teaser line
  $('#L-hook-top').classList.add('hidden');
  showOnly('L-hook'); $('#hk-main').innerHTML='<span class="word">Prêt·e&nbsp;?</span>';
  $('#hk-main').classList.add('slam');
  await sleep(DROP-1500-1000); if(abort)return;

  // ── THE DROP (beat 0, ~3.75s) ── flash + title slam.
  // From here every image swap lands on a beat (128 BPM = "Animals" kicks).
  flash(); beatPulse();
  showPhoto(1,{fast:true});
  showOnly('L-hook');
  $('#hk-main').classList.remove('slam'); void $('#hk-main').offsetWidth;
  $('#hk-main').innerHTML='La forêt<br><span class="g">comme jamais</span>';
  $('#hk-main').classList.add('slam');
  $('#hk-sub').textContent='À pied · à vélo · en courant';
  fadeIn($('#hk-sub'),380);

  // beat-locked montage: one image change PER BEAT, synced to the 128-BPM drop.
  const CUTS = 32;                               // beats 0..31 (drop → CTA)
  for(let b=0;b<CUTS;b++){
    if(abort)return;
    showPhoto(1+b,{fast:true});                  // ← image changes on the beat
    beatPulse();
    if(b===8){ resetFades(); showOnly(null); addTag(TAGS[0]); } // hide title, start pills
    else if(b===13){ addTag(TAGS[1]); }
    else if(b===18){ addTag(TAGS[2]); }
    else if(b===23){ clearTags(); addTag(TAGS[3]); }
    else if(b===26){                              // statement line over the beat cuts
      clearTags(); resetFades(); showOnly('L-hook'); flash();
      $('#hk-main').classList.remove('slam'); void $('#hk-main').offsetWidth;
      $('#hk-main').innerHTML='Ta prochaine<br><span class="g">balade</span> t’attend';
      $('#hk-main').classList.add('slam'); $('#hk-sub').textContent='';
    }
    await sleep(BEAT*1000);
  }

  // SCENE — CTA (final 2 bars)
  if(abort)return;
  resetFades(); showOnly('L-cta');
  showPhoto(11,{fast:false}); flash();
  fadeIn($('#cta-logo'),120); fadeIn($('#cta-btn'),560); fadeIn($('#cta-url'),880);
  $('#cta-logo').classList.add('beat');
}

// ── generated soundtrack (PREVIEW ONLY — synthesized live) ──
// The exported video (make-hype.mjs) muxes the real purchased EDM track.
// This is a quick electro loop just so the local page isn't silent.
let audioCtx=null, musicStop=null;
function startMusic(){
  stopMusic();
  const AC=window.AudioContext||window.webkitAudioContext; if(!AC) return;
  const ac=new AC(); audioCtx=ac;
  const master=ac.createGain(); const t0=ac.currentTime+0.06;
  master.gain.setValueAtTime(0,t0); master.gain.linearRampToValueAtTime(0.8,t0+0.8);
  master.connect(ac.destination);
  const bpm=128, beat=60/bpm, bars=12, end=t0+bars*4*beat;
  const N={A2:110,C3:130.81,E3:164.81,A3:220,C4:261.63,E4:329.63,G4:392,A4:440,C5:523.25,E5:659.25};
  const lead=[N.A4,N.C5,N.E5,N.C5,N.G4,N.C5,N.E5,N.A4], bass=[N.A2,N.A2,N.C3,N.E3];
  function tone(f,s,d,ty,g,pan){const o=ac.createOscillator();o.type=ty;o.frequency.setValueAtTime(f,s);
    const gg=ac.createGain();gg.gain.setValueAtTime(0,s);gg.gain.linearRampToValueAtTime(g,s+0.01);
    gg.gain.exponentialRampToValueAtTime(0.0001,s+d);let n=gg;if(pan!==undefined){const p=ac.createStereoPanner();p.pan.value=pan;gg.connect(p);n=p;}
    o.connect(gg);n.connect(master);o.start(s);o.stop(s+d+0.05);}
  function kick(s){const o=ac.createOscillator(),g=ac.createGain();o.frequency.setValueAtTime(160,s);
    o.frequency.exponentialRampToValueAtTime(45,s+0.12);g.gain.setValueAtTime(1,s);g.gain.exponentialRampToValueAtTime(0.001,s+0.2);
    o.connect(g);g.connect(master);o.start(s);o.stop(s+0.22);}
  function hat(s){const b=ac.createBuffer(1,(ac.sampleRate*0.05)|0,ac.sampleRate);const d=b.getChannelData(0);
    for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,2);const src=ac.createBufferSource();src.buffer=b;
    const hp=ac.createBiquadFilter();hp.type='highpass';hp.frequency.value=7500;const g=ac.createGain();g.gain.value=0.16;
    src.connect(hp);hp.connect(g);g.connect(master);src.start(s);}
  for(let bar=0;bar<bars;bar++){const bs=t0+bar*4*beat;
    if(bar>=2){for(let b=0;b<4;b++){kick(bs+b*beat);hat(bs+b*beat+0.5*beat);}
      tone(bass[bar%4],bs,2*beat,'sawtooth',0.22,0);tone(bass[(bar+1)%4],bs+2*beat,2*beat,'sawtooth',0.22,0);
      for(let i=0;i<8;i+=2)tone(lead[(bar*2+i/2)%lead.length],bs+i*0.5*beat,0.85*beat,'square',0.11,0.12);}
    else for(let i=0;i<8;i++)tone(lead[i%lead.length],bs+i*0.5*beat,0.4*beat,'triangle',0.10,i%2?0.2:-0.2);
    if(bar===bars-1)[N.A3,N.C4,N.E4,N.A4,N.C5].forEach(f=>tone(f,bs,2.4,'triangle',0.18,0));}
  master.gain.setValueAtTime(0.8,end-0.7); master.gain.linearRampToValueAtTime(0,end+0.3);
  musicStop=()=>{try{ac.close();}catch(e){}};
}
function stopMusic(){ if(musicStop){musicStop();musicStop=null;} }
function startSound(){ if(audioEl){audioEl.currentTime=0;audioEl.play().catch(()=>{});} else startMusic(); }

// ── controls ───────────────────────────────────────────────
$('#playBtn').addEventListener('click',()=>{ $('#gate').style.display='none'; startSound(); play(); });
$('#replay').addEventListener('click',async()=>{ abort=true; stopMusic(); await sleep(60); abort=false; startSound(); play(); });
$('#rec').addEventListener('click',async()=>{
  if(!navigator.mediaDevices?.getDisplayMedia){ alert('Ton navigateur ne supporte pas l’enregistrement.'); return; }
  let stream; try{ stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:30},audio:true,preferCurrentTab:true}); }catch(e){ return; }
  const mime = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4'
            : MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm';
  const rec=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:9000000});
  const chunks=[]; rec.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
  rec.onstop=()=>{ const blob=new Blob(chunks,{type:mime}); const a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download='bwr-reel-hype'+(mime.includes('mp4')?'.mp4':'.webm');
    document.body.appendChild(a); a.click(); a.remove(); stream.getTracks().forEach(t=>t.stop());
    $('#rec').textContent='⏺ Enregistrer la vidéo'; };
  $('#rec').textContent='● Enregistrement…'; $('#gate').style.display='none';
  abort=true; stopMusic(); await sleep(80); abort=false;
  rec.start(); startSound(); play();
  setTimeout(()=>{ try{ rec.stop(); }catch(e){} }, TOTAL+700);
});
$('#fs').addEventListener('click',()=>{ const s=$('#stage'); if(!document.fullscreenElement) s.requestFullscreen?.(); else document.exitFullscreen?.(); });

let audioEl=null;
$('#audio').addEventListener('change',e=>{ const f=e.target.files[0]; if(!f)return; if(audioEl)audioEl.pause(); audioEl=new Audio(URL.createObjectURL(f)); audioEl.loop=false; });

buildPhotos();
