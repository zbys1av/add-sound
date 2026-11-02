'use strict';

/* SoundLayer · static browser edition. No upload/API/backend. */
const $ = id => document.getElementById(id);
const clamp = (n,a,b) => Math.min(b,Math.max(a,n));
const fmt = secs => { const n=Math.max(0,Math.floor(Number(secs)||0)); return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; };
const fixed = n => Number(n).toFixed(3);
const round = n => Math.round(n*10)/10;
const esc = text => String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = {
  video:null, sources:new Map(), library:[], tracks:[], transition:2,
  ffmpeg:null, enginePromise:null, cancelled:false, busy:false, outputURL:null,
  engineController:null, workerURL:null, pendingFFmpeg:null, originalAudioKnown:null, logs:[], qualityVerified:false
};
const players = new Map();
let nextTrackId=0, sampleAudio=null, sampleId=null, previewTimer=null;

const icons = {
 rain:'<path d="M6 12a4.8 4.8 0 0 1 4.7-5 6 6 0 0 1 11 3.2A3.8 3.8 0 0 1 20 17H7a4 4 0 0 1-1-5Z"/><path d="m8 20-1 2m6-2-1 2m6-2-1 2"/>',
 fire:'<path d="M13 2c2 5-2 6 1 10 2-2 3-4 3-6 5 4 7 9 4 13-3 4-11 5-15 0-4-5 0-10 3-13-.4 4 1 5 2 6 0-4 0-7 2-10Z"/><path d="M12 23c-3-3-1-5 1-7 1 2 3 4 1 7"/>',
 wind:'<path d="M3 8h12c5 0 5-6 1-6-2 0-3 1-3 3M2 12h18c4 0 4 6 0 6-2 0-3-2-3-3M4 17h9c4 0 4 5 0 5-2 0-2-1-2-2"/>',
 ocean:'<path d="M2 9c3 0 3-3 6-3s3 3 6 3 3-3 6-3 3 3 4 3M2 15c3 0 3-3 6-3s3 3 6 3 3-3 6-3 3 3 4 3M2 21c3 0 3-3 6-3s3 3 6 3 3-3 6-3 3 3 4 3"/>',
 forest:'<path d="m12 2 8 10h-4l5 7H3l5-7H4L12 2ZM12 19v4"/>',
 river:'<path d="M3 4h8c5 0 7 3 2 6l-3 2c-5 3-3 5 2 5h9M3 10h6m-6 7h4m10 4h4"/>'
};
const svgIcon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[k]||icons.rain}</svg>`;
const fieldRecordings={
 rain:'https://upload.wikimedia.org/wikipedia/commons/3/3d/Rain.ogg',
 fire:'https://upload.wikimedia.org/wikipedia/commons/d/d8/Dry_grass_burning_in_open_fireplace.ogg',
 wind:'https://upload.wikimedia.org/wikipedia/commons/2/2d/Howling_wind.ogg',
 ocean:'https://upload.wikimedia.org/wikipedia/commons/1/1f/Waves.ogg',
 forest:'https://upload.wikimedia.org/wikipedia/commons/3/38/Birds_forest.ogg',
 river:'https://upload.wikimedia.org/wikipedia/commons/2/26/Flowing-water-100019.ogg'
};
const soundData=[
 ['rain','Дощ','Живий запис дощу'],
 ['fire','Вогонь','Горіння в каміні — польовий запис'],
 ['wind','Вітер','Запис виття вітру'],
 ['ocean','Океан','Польовий запис хвиль'],
 ['forest','Ліс','Птахи у лісі'],
 ['river','Струмок','Живий запис води']
];
function notice(message,bad=false){$('uploadInfo').textContent=message;$('uploadInfo').classList.toggle('error',bad);}
function videoLen(){return state.video?.duration||0;}
function setEngineInfo(title,message,bad=false){
 const b=$('engineBanner');b.hidden=false;b.classList.toggle('engine-error',bad);
 $('engineTitle').textContent=title;$('engineMessage').textContent=message;
}
function enableUI(){
 $('exportBtn').disabled=!state.video||!state.tracks.length||state.busy;
 $('autoFade').disabled=!state.video||state.tracks.length<2||state.busy;
 $('chooseVideo').disabled=state.busy;
 $('replaceVideo').disabled=state.busy;
 $('audioDrop').classList.toggle('disabled',state.busy);
}
function audioDuration(url){return new Promise(resolve=>{
 const a=new Audio();let settled=false;
 const finish=(n)=>{if(settled)return;settled=true;a.removeAttribute('src');a.load();resolve(Number.isFinite(n)&&n>0?n:0);};
 a.preload='metadata';a.onloadedmetadata=()=>finish(a.duration);a.onerror=()=>finish(0);a.src=url;
 setTimeout(()=>finish(0),7000);
});}
function browserDiagnostics(){
 const ua=navigator.userAgent;const firefox=/Firefox\//i.test(ua),safari=/Safari\//i.test(ua)&&!/Chrome|Chromium|Edg\//i.test(ua);
 const missing=[];
 if(!window.WebAssembly)missing.push('WebAssembly');
 if(!window.Worker)missing.push('Web Workers');
 if(!window.OfflineAudioContext)missing.push('Web Audio');
 if(!window.AudioEncoder)missing.push('WebCodecs AudioEncoder');
 let msg='';
 if(missing.length)msg=`Браузеру бракує ${missing.join(', ')}. Швидкий експорт може бути недоступний; застосунок спробує FFmpeg.wasm.`;
 else if(firefox)msg='Firefox: швидкий експорт залежить від наявності аудіокодека WebCodecs. Якщо він недоступний, використаємо повільніший FFmpeg.wasm.';
 else if(safari)msg='Safari: підтримка кодеків і пам’яті залежить від версії та пристрою. Для складних файлів можливий резервний експорт FFmpeg.wasm.';
 if(location.protocol==='file:')msg+=' Для стабільної роботи відкрийте застосунок через GitHub Pages.';
 const b=$('browserBanner');b.hidden=!msg;b.textContent=msg;
}
async function addAudioFromUrl(){
 const field=$('audioUrl'), raw=field.value.trim();if(!raw)return;
 let url;try{url=new URL(raw)}catch{notice('Некоректне посилання.',true);return;}
 if(url.protocol!=='https:'){notice('Підтримуються лише HTTPS-посилання.',true);return;}
 const yt=/^(www\.|m\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(url.hostname);
 const wrap=$('youtubePreview');wrap.replaceChildren();wrap.hidden=true;
 if(yt){
  let id=url.hostname.includes('youtu.be')?url.pathname.split('/')[1]:url.searchParams.get('v');
  if(!id){const m=url.pathname.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);id=m?.[1];}
  if(id&&/^[A-Za-z0-9_-]{11}$/.test(id)){
   const iframe=document.createElement('iframe');iframe.src=`https://www.youtube-nocookie.com/embed/${id}`;iframe.title='Попередній перегляд YouTube';iframe.allow='accelerometer; encrypted-media; picture-in-picture';iframe.loading='lazy';wrap.append(iframe);wrap.hidden=false;
  }
  notice('YouTube: перегляд доступний, але витягування звуку з ролика для експорту не підтримується. Використайте свій аудіофайл.',true);return;
 }
 if(!state.video){notice('Спочатку додайте відео.',true);return;}
 if(!/\.(mp3|wav|ogg|opus|m4a|aac|flac)(?:$)/i.test(url.pathname)){notice('Потрібне пряме посилання на аудіофайл (.mp3, .ogg, .wav тощо), не сторінка.',true);return;}
 const button=$('addAudioUrl');button.disabled=true;
 try{
  const res=await fetch(url.href,{mode:'cors'});
  if(!res.ok)throw new Error('HTTP '+res.status);
  const blob=await res.blob();if(blob.size>50*1048576)throw new Error('Аудіофайл завеликий (максимум 50 МБ).');
  const name=decodeURIComponent(url.pathname.split('/').pop())||'audio.mp3';
  await loadAudios([new File([blob],name,{type:blob.type||'audio/mpeg'})]);field.value='';
 }catch(e){notice(`Не вдалося завантажити аудіо. Сервер має дозволяти CORS. ${e.message}`,true);}
 finally{button.disabled=false;}
}
async function init(){
 browserDiagnostics();
 $('addAudioUrl').addEventListener('click',addAudioFromUrl);
 $('audioUrl').addEventListener('keydown',e=>{if(e.key==='Enter')addAudioFromUrl();});
 state.library=soundData.map(([id,name,description])=>({id,name,description,icon:id,url:fieldRecordings[id],fallbackUrl:`./assets/${id}.mp3`,builtIn:true,duration:0}));
 for(const sound of state.library){state.sources.set(sound.id,sound); audioDuration(sound.url).then(d=>{sound.duration=d;});}
 showLibrary();renderTracks();
 if(location.protocol==='file:')setEngineInfo('Рекомендовано GitHub Pages','Редактор може відкриватися як HTML, але FFmpeg.wasm у деяких браузерах блокується з file://. Завантажте ці файли на GitHub Pages для надійного експорту.');
}
function showLibrary(){
 $('soundLibrary').innerHTML=state.library.map(s=>`<div class="sound-card"><span class="sound-icon">${svgIcon(s.icon)}</span><div class="sound-text"><strong>${esc(s.name)}</strong><small>${esc(s.description)}</small></div><div class="sound-actions"><button class="square-btn preview" data-sample="${s.id}" title="Прослухати" aria-label="Прослухати ${esc(s.name)}">${sampleId===s.id?'■':'▶'}</button><button class="square-btn" data-add="${s.id}" title="Додати звук" aria-label="Додати ${esc(s.name)}">+</button></div></div>`).join('');
 for(const b of $('soundLibrary').querySelectorAll('[data-add]'))b.addEventListener('click',()=>addTrack(b.dataset.add));
 for(const b of $('soundLibrary').querySelectorAll('[data-sample]'))b.addEventListener('click',()=>playSample(b.dataset.sample));
}
function stopSample(){if(sampleAudio){sampleAudio.pause();sampleAudio=null;}sampleId=null;showLibrary();}
function playSample(id){if(sampleId===id){stopSample();return;}stopSample();const src=state.sources.get(id);if(!src)return;
 sampleId=id;sampleAudio=new Audio(src.url);sampleAudio.volume=.7;showLibrary();
 sampleAudio.play().catch(()=>{if(src.fallbackUrl){sampleAudio.src=src.fallbackUrl;sampleAudio.play().catch(()=>{notice('Браузер не може відтворити звук.',true);stopSample();});}else{notice('Браузер не може відтворити звук.',true);stopSample();}});
 sampleAudio.addEventListener('ended',()=>stopSample(),{once:true});
}
async function loadVideo(file){
 if(!file||state.busy)return;
 if(!(file.type.startsWith('video/')||/\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(file.name))){notice('Виберіть відеофайл.',true);return;}
 const newURL=URL.createObjectURL(file);
 const video=$('video');video.pause();stopAllAudio();stopSample();
 const oldURL=state.video?.url;
 const info=await new Promise((resolve,reject)=>{
   const ok=()=>{cleanup();resolve({duration:video.duration,width:video.videoWidth,height:video.videoHeight});};
   const bad=()=>{cleanup();reject(new Error('Браузер не може відкрити це відео для перегляду. Спробуйте MP4 (H.264) або WebM.'));};
   const cleanup=()=>{video.removeEventListener('loadedmetadata',ok);video.removeEventListener('error',bad);};
   video.addEventListener('loadedmetadata',ok);video.addEventListener('error',bad);video.src=newURL;video.load();
 }).catch(e=>{URL.revokeObjectURL(newURL);if(oldURL){video.src=oldURL;video.load();}notice(e.message,true);return null;});
 if(!info)return;
 if(!Number.isFinite(info.duration)||info.duration<=0){notice('Не вдалося визначити тривалість цього відео.',true);URL.revokeObjectURL(newURL);if(oldURL){video.src=oldURL;video.load();}return;}
 state.video={file,url:newURL,duration:info.duration,width:info.width,height:info.height};
 state.originalAudioKnown=null;
 if(oldURL)URL.revokeObjectURL(oldURL);
 video.hidden=false;$('videoDrop').classList.add('has-video');$('videoDrop').querySelector('.drop-content').hidden=true;
 $('videoDetails').hidden=false;$('videoName').textContent=file.name;
 $('videoMeta').innerHTML=`<span>${fmt(info.duration)}</span><span>${info.width}×${info.height}</span><span>${(file.size/1048576).toFixed(1)} МБ</span>`;
 $('originalToggle').disabled=false;setOriginalAudio();
 for(const t of state.tracks){t.start=clamp(t.start,0,Math.max(0,videoLen()-.1));t.duration=clamp(t.duration,.1,Math.max(.1,videoLen()-t.start));t.fadeIn=Math.min(t.fadeIn,t.duration/2);t.fadeOut=Math.min(t.fadeOut,t.duration/2);}
 renderTracks();notice('Відео готове. Додайте звукову доріжку.');
}
async function loadAudios(files){
 const list=Array.from(files||[]);if(!list.length)return;
 if(state.busy){notice('Зачекайте завершення експорту.',true);return;}
 if(!state.video){notice('Спочатку додайте відео.',true);return;}
 for(const file of list){
  if(!(file.type.startsWith('audio/')||/\.(mp3|wav|m4a|aac|ogg|opus|flac|wma)$/i.test(file.name))){notice(`Пропущено файл ${file.name}: це не аудіо.`,true);continue;}
  const id=`custom-${crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random()}`;
  const url=URL.createObjectURL(file);const duration=await audioDuration(url);
  const src={id,name:file.name,icon:'rain',description:'Власний звук',url,file,duration,builtIn:false};
  state.sources.set(id,src);addTrack(id);
 }
 notice(`Додано аудіофайлів: ${list.length}.`);
}
function addTrack(sourceId){
 if(!state.video){notice('Спочатку додайте відео.',true);return;}
 if(state.busy)return;
 const src=state.sources.get(sourceId);if(!src)return;
 const duration=videoLen();
 const t={id:++nextTrackId,sourceId,start:0,duration:src.builtIn?duration:Math.min(duration,src.duration||duration),volume:70,loop:!!src.builtIn,fadeIn:0,fadeOut:0};
 state.tracks.push(t);renderTracks();notice(`«${src.name}» додано на таймлайн.`);
}
function reorderTrack(id,delta){const index=state.tracks.findIndex(t=>t.id===id);const target=index+delta;if(index<0||target<0||target>=state.tracks.length)return;
 [state.tracks[index],state.tracks[target]]=[state.tracks[target],state.tracks[index]];renderTracks();}
function autoFade(){const count=state.tracks.length;if(count<2)return;
 const total=videoLen();const cross=clamp(state.transition,0,Math.max(0,total/(count+1)));
 const d=(total+(count-1)*cross)/count;
 state.tracks.forEach((t,i)=>{
 t.start=round(i*(d-cross));t.duration=round(Math.max(.1,Math.min(d,total-t.start)));
 t.fadeIn=i===0?0:Math.min(cross,t.duration/2);
 t.fadeOut=i===count-1?0:Math.min(cross,t.duration-t.fadeIn);
 t.loop=true;
 });
 renderTracks();notice('Звуки розподілено послідовно з плавними переходами.');
}
function renderRuler(){$('timelineRuler').innerHTML=`<span>00:00</span><span>${videoLen()?fmt(videoLen()/2):'Додайте відео'}</span><span>${videoLen()?fmt(videoLen()):'—'}</span>`;}
function renderTimeline(){
 const len=videoLen()||1;
 for(const t of state.tracks){
 const bar=$('bar-'+t.id);if(!bar)continue;
 bar.style.left=`${t.start/len*100}%`;bar.style.width=`${Math.max(0,t.duration)/len*100}%`;
 bar.querySelector('.fade-in').style.width=`${t.fadeIn/Math.max(.1,t.duration)*100}%`;
 bar.querySelector('.fade-out').style.width=`${t.fadeOut/Math.max(.1,t.duration)*100}%`;
 }
}
function renderTracks(){
 $('trackCount').textContent=state.tracks.length;
 $('emptyTracks').hidden=!!state.tracks.length;
 $('timelineTracks').innerHTML=state.tracks.map((t,i)=>{
 const s=state.sources.get(t.sourceId);
 return `<div class="track-card" data-track="${t.id}"><div class="track-top"><div class="track-title"><span class="track-index">${String(i+1).padStart(2,'0')}</span>${esc(s?.name||'Аудіо')}</div><div class="track-actions"><button data-move="-1" title="Перемістити вище" aria-label="Вище">↑</button><button data-move="1" title="Перемістити нижче" aria-label="Нижче">↓</button><button data-delete title="Видалити доріжку" class="delete" aria-label="Видалити">×</button></div></div>
 <div class="track-visual" title="Перетягніть смугу, щоб змінити початок"><div class="track-clip" id="bar-${t.id}"><div class="fade-in"></div><div class="fade-out"></div></div></div>
 <div class="track-fields"><div class="track-field"><label>Початок (с)</label><input data-field="start" aria-label="Початок ${esc(s?.name||'')}" type="number" min="0" step="0.1" max="${videoLen()}" value="${round(t.start)}"></div>
 <div class="track-field"><label>Тривалість (с)</label><input data-field="duration" aria-label="Тривалість" type="number" min="0.1" step="0.1" max="${videoLen()}" value="${round(t.duration)}"></div>
 <div class="track-field"><label>Поява (с)</label><input data-field="fadeIn" aria-label="Плавна поява" type="number" min="0" step="0.1" value="${round(t.fadeIn)}"></div>
 <div class="track-field"><label>Згасання (с)</label><input data-field="fadeOut" aria-label="Плавне згасання" type="number" min="0" step="0.1" value="${round(t.fadeOut)}"></div>
 <div class="track-volume track-field"><label>Гучність <span class="volume-display" id="track-vol-${t.id}">${t.volume}%</span></label><input data-field="volume" aria-label="Гучність" type="range" min="0" max="100" step="1" value="${t.volume}"></div></div>
 <label class="track-loop"><input data-field="loop" type="checkbox" ${t.loop?'checked':''}> Повторювати звук, якщо він коротший за доріжку</label></div>`;
 }).join('');
 for(const card of $('timelineTracks').querySelectorAll('.track-card')){
  const id=Number(card.dataset.track);
  for(const el of card.querySelectorAll('[data-field]')){
   el.addEventListener(el.type==='checkbox'?'change':'input',()=>{
    const t=state.tracks.find(x=>x.id===id);if(!t)return;
    const f=el.dataset.field,n=Number(el.value);
    if(f==='loop')t.loop=el.checked;
    else if(el.value!==''&&Number.isFinite(n)){
     if(f==='volume'){t.volume=clamp(n,0,100);$('track-vol-'+id).textContent=t.volume+'%';}
     if(f==='start'){t.start=clamp(n,0,Math.max(0,videoLen()-.1));t.duration=Math.min(t.duration,videoLen()-t.start);}
     if(f==='duration')t.duration=clamp(n,.1,Math.max(.1,videoLen()-t.start));
     if(f==='fadeIn')t.fadeIn=clamp(n,0,Math.max(0,t.duration-t.fadeOut));
     if(f==='fadeOut')t.fadeOut=clamp(n,0,Math.max(0,t.duration-t.fadeIn));
    }
    renderTimeline();syncAudios();
   });
   if(el.type==='number')el.addEventListener('change',renderTracks);
  }
  card.querySelector('[data-delete]').addEventListener('click',()=>{
   const p=players.get(id);if(p){p.pause();players.delete(id);}state.tracks=state.tracks.filter(t=>t.id!==id);
   renderTracks();
  });
  card.querySelectorAll('[data-move]').forEach(b=>b.addEventListener('click',()=>reorderTrack(id,Number(b.dataset.move))));
  const bar=card.querySelector('.track-clip');let dragging=null;
  bar.addEventListener('pointerdown',e=>{if(e.button!==0)return;const t=state.tracks.find(x=>x.id===id);dragging={x:e.clientX,start:t.start};bar.setPointerCapture(e.pointerId);bar.style.cursor='grabbing';});
  bar.addEventListener('pointermove',e=>{if(!dragging)return;const t=state.tracks.find(x=>x.id===id);const width=bar.parentElement.getBoundingClientRect().width||1;t.start=round(clamp(dragging.start+(e.clientX-dragging.x)/width*videoLen(),0,Math.max(0,videoLen()-t.duration)));renderTimeline();syncAudios();});
  const finish=()=>{if(!dragging)return;dragging=null;bar.style.cursor='grab';renderTracks();};
  bar.addEventListener('pointerup',finish);bar.addEventListener('pointercancel',finish);
 }
 renderRuler();renderTimeline();enableUI();syncAudios();
}
function setOriginalAudio(){
 $('originalControls').style.opacity=$('originalToggle').checked?1:.4;
 $('originalVolumeValue').textContent=$('originalVolume').value+'%';
 const v=$('video');v.muted=!$('originalToggle').checked;v.volume=Number($('originalVolume').value)/100;
}
function stopAllAudio(){for(const a of players.values())a.pause();}
function syncAudios(){
 const video=$('video');if(!state.video)return;const time=video.currentTime||0;
 for(const [id,a] of players)if(!state.tracks.some(t=>t.id===id)){a.pause();players.delete(id);}
 for(const track of state.tracks){
 const src=state.sources.get(track.sourceId);if(!src)continue;
 let audio=players.get(track.id);if(!audio){audio=new Audio(src.url);audio.preload='auto';if(src.fallbackUrl){audio.addEventListener('error',()=>{if(!audio.src.endsWith(src.fallbackUrl.replace('./','/'))&&audio.dataset.fallback!=='1'){audio.dataset.fallback='1';audio.src=src.fallbackUrl;audio.load();notice('Запис недоступний, відтворюється резервний звук.');}});}players.set(track.id,audio);}
 const relative=time-track.start;
 const natural=(Number.isFinite(audio.duration)&&audio.duration>0)?audio.duration:(src.duration||track.duration);
 const active=relative>=0&&relative<track.duration&&(track.loop||relative<natural)&&!video.paused&&!video.ended;
 if(!active){audio.pause();continue;}
 const desired=track.loop?relative%Math.max(.01,natural):relative;
 if(Number.isFinite(desired)&&Math.abs(audio.currentTime-desired)>.45){try{audio.currentTime=desired;}catch(_){} }
 const fadeIn=track.fadeIn?clamp(relative/track.fadeIn,0,1):1;
 const fadeOut=track.fadeOut?clamp((track.duration-relative)/track.fadeOut,0,1):1;
 audio.volume=clamp(track.volume/100*Math.min(fadeIn,fadeOut),0,1);audio.loop=track.loop;
 if(audio.paused)audio.play().catch(()=>{});
 }
}

async function sourceBytes(src){
 if(src.file)return src.file.arrayBuffer();
 try{const r=await fetch(src.url,{mode:'cors'});if(!r.ok)throw new Error('HTTP '+r.status);return await r.arrayBuffer();}
 catch(e){if(!src.fallbackUrl)throw e;notice(`Польовий запис «${src.name}» недоступний. Використано резервний звук.`,true);src.activeFallback=true;return (await fetch(src.fallbackUrl)).arrayBuffer();}
}
/* Video is always copied, never re-encoded. */
const CDN='https://cdn.jsdelivr.net/npm';
const FFMPEG_CORE_VERSION='0.12.10';
const FFMPEG_WRAPPER_VERSION='0.12.15';
const ENGINE_CACHE='soundlayer-ffmpeg-core-0.12.10-v1';
const ENGINE_TIMEOUT=120000;
// Keep download bytes in Cache Storage, not just short-lived in-memory blob URLs.
// The first 32 MB download is unavoidable; subsequent launches can use cached bytes.
function engineProgress(label,completed,total){
 const fraction=total>0?completed/total:0;
 const percent=Math.round(Math.min(1,Math.max(0,fraction))*100);
 const banner=$('engineBanner');banner.hidden=false;banner.classList.remove('engine-error');
 $('engineTitle').textContent=label;
 $('engineMessage').textContent=total>0?`${(completed/1048576).toFixed(1)} із ${(total/1048576).toFixed(1)} МБ · ${percent}%`:'Готуємо компоненти. Швидкість залежить від мережі та браузера.';
 $('enginePercent').textContent=total>0?`${percent}%`:'';
 setExportStatus(label,$('engineMessage').textContent,Math.round(5+percent*.18));
}
async function engineAssetURL(url,type,signal,progress){
 let cache=null,response=null,hit=false;
 try{if('caches' in window){cache=await caches.open(ENGINE_CACHE);response=await cache.match(url);hit=!!response;}}catch(error){console.warn('Cache Storage недоступний:',error);}
 if(!response){
  try{response=await fetch(url,{mode:'cors',cache:'force-cache',signal});}
  catch(e){throw new Error(`Не вдалося завантажити FFmpeg. Перевірте інтернет, блокувальники та CDN (${e.message}).`);}
  if(!response.ok)throw new Error(`Не вдалося отримати FFmpeg (HTTP ${response.status}).`);
  if(cache){cache.put(url,response.clone()).catch(e=>console.warn('Кешування FFmpeg недоступне:',e));}
 }
 let blob;
 const total=Number(response.headers.get('Content-Length'))||0;
 if(response.body&&total>0){
  const reader=response.body.getReader(),parts=[];let loaded=0;
  for(;;){
   if(signal.aborted){await reader.cancel();throw new DOMException('Скасовано','AbortError');}
   const {done,value}=await reader.read();if(done)break;
   parts.push(value);loaded+=value.byteLength;progress?.(loaded,total,hit);
  }
  blob=new Blob(parts,{type});
 }else{
  blob=new Blob([await response.arrayBuffer()],{type});
  progress?.(blob.size,blob.size,hit);
 }
 return {url:URL.createObjectURL(blob),size:blob.size,cached:hit};
}
async function ensureEngine(){
 if(state.ffmpeg?.loaded)return state.ffmpeg;
 if(state.enginePromise)return state.enginePromise;
 const controller=new AbortController();state.engineController=controller;
 const signal=controller.signal;
 const job=(async()=>{
  if(!window.FFmpegWASM?.FFmpeg)throw new Error('Не завантажилася оболонка FFmpeg.wasm. Перевірте доступ до jsDelivr або блокувальник реклами.');
  const ffmpeg=new window.FFmpegWASM.FFmpeg();state.pendingFFmpeg=ffmpeg;
  const urls=[];
  ffmpeg.on('log',({message})=>{state.logs.push(message);if(state.logs.length>90)state.logs.shift();});
  ffmpeg.on('progress',({progress})=>{if(state.busy&&Number.isFinite(progress)&&progress>=0&&progress<=1){$('exportProgress').style.width=`${Math.max(35,Math.min(94,35+progress*57))}%`;}});
  const base=`${CDN}/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`;
  const files=[
   {url:`${CDN}/@ffmpeg/ffmpeg@${FFMPEG_WRAPPER_VERSION}/dist/umd/814.ffmpeg.js`,mime:'text/javascript',name:'Службовий модуль'},
   {url:`${base}/ffmpeg-core.js`,mime:'text/javascript',name:'Звуковий рушій'},
   {url:`${base}/ffmpeg-core.wasm`,mime:'application/wasm',name:'FFmpeg WebAssembly'}
  ];
  try{
   let downloaded=0;
   const assets=[];
   setEngineInfo('Підготовка FFmpeg','Перевіряємо кеш компонентів…');
   for(let i=0;i<files.length;i++){
    const f=files[i];
    const asset=await engineAssetURL(f.url,f.mime,signal,(read,total,cached)=>{
      engineProgress(cached?`${f.name}: із кешу`:`Завантаження: ${f.name}`,read,total);
    });
    urls.push(asset.url);assets.push(asset);
    downloaded+=asset.size;
    if(signal.aborted||state.cancelled)throw new DOMException('Скасовано','AbortError');
   }
   setEngineInfo('Ініціалізація FFmpeg','Компоненти підготовлені. Запускаємо WebAssembly…');
   $('enginePercent').textContent='';
   setExportStatus('Запуск FFmpeg.wasm','Компоненти вже завантажені. Браузер ініціалізує WebAssembly; це може тривати деякий час.',24);
   let timeoutId;
   try{
    await Promise.race([
      ffmpeg.load({classWorkerURL:assets[0].url,coreURL:assets[1].url,wasmURL:assets[2].url},{signal}),
      new Promise((_,reject)=>{timeoutId=setTimeout(()=>reject(new Error('FFmpeg не ініціалізувався за 120 секунд. Перевірте пам’ять браузера або спробуйте Chrome/Edge.')),ENGINE_TIMEOUT);})
    ]);
   }finally{clearTimeout(timeoutId);}
   if(state.cancelled||signal.aborted)throw new DOMException('Скасовано','AbortError');
   state.ffmpeg=ffmpeg;
   state.pendingFFmpeg=null;
   $('engineBanner').hidden=true;
   return ffmpeg;
  }catch(e){
   ffmpeg.terminate();
   if(state.pendingFFmpeg===ffmpeg)state.pendingFFmpeg=null;
   setEngineInfo('FFmpeg не запустився',e.message,true);
   throw e;
  }finally{for(const u of urls)URL.revokeObjectURL(u);}
 })();
 state.enginePromise=job;
 try{return await job;}finally{if(state.enginePromise===job)state.enginePromise=null;if(state.engineController===controller)state.engineController=null;}
}
function setExportStatus(title,message,percent){
 $('exportStatus').hidden=false;$('exportTitle').textContent=title;
 $('exportInfo').textContent=message;$('exportInfo').classList.remove('error');
 $('exportProgress').style.width=`${percent}%`;
}
function typeFor(fileName){const ext=(fileName.split('.').pop()||'').toLowerCase();return /^(mp4|mov|m4v)$/.test(ext)?'mp4':ext==='webm'?'webm':'mkv';}
function extFor(fileName,fallback='bin'){
 const ext=(fileName.split('.').pop()||'').toLowerCase();return /^[a-z0-9]{1,6}$/.test(ext)?ext:fallback;
}
function graphFor(tracks,videoDuration,hasOriginal){
 const graph=[],ids=[];
 if(hasOriginal){
   graph.push(`[0:a:0]atrim=duration=${fixed(videoDuration)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=${fixed(Number($('originalVolume').value)/100)}[orig]`);
   ids.push('[orig]');
 }
 tracks.forEach((t,i)=>{
  const len=Math.max(.05,Math.min(t.duration,videoDuration-t.start));
  const fadeIn=Math.min(t.fadeIn,len),fadeOut=Math.min(t.fadeOut,len-fadeIn);
  const chain=[`[${i+1}:a:0]`, `atrim=duration=${fixed(len)}`, 'asetpts=PTS-STARTPTS',
    'aformat=sample_rates=48000:channel_layouts=stereo', `volume=${fixed(t.volume/100)}`];
  if(fadeIn>.001)chain.push(`afade=t=in:st=0:d=${fixed(fadeIn)}`);
  if(fadeOut>.001)chain.push(`afade=t=out:st=${fixed(Math.max(0,len-fadeOut))}:d=${fixed(fadeOut)}`);
  if(t.start>0)chain.push(`adelay=${Math.round(t.start*1000)}:all=1`);
  chain.push(`apad=whole_dur=${fixed(videoDuration)}`);
  graph.push(`${chain[0]}${chain.slice(1).join(',')}[s${i}]`);ids.push(`[s${i}]`);
 });
 graph.push(`${ids.join('')}amix=inputs=${ids.length}:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${fixed(videoDuration)},asetpts=PTS-STARTPTS[mix]`);
 return graph.join(';');
}
function buildCommand({videoName,trackNames,tracks,videoDuration,hasOriginal,format,output}){
 const args=['-hide_banner','-nostats','-i',videoName];
 tracks.forEach((t,i)=>{
  if(t.loop)args.push('-stream_loop','-1');
  args.push('-i',trackNames[i]);
 });
 args.push('-filter_complex',graphFor(tracks,videoDuration,hasOriginal));
 args.push('-map','0:v:0','-map','[mix]','-c:v','copy','-c:a',format==='webm'?'libvorbis':'aac','-b:a','192k');
 // Avoid +faststart: second full-file pass slows down browser exports.
 // Never use -shortest or an output -t: either can trim the original video packets.
 args.push(output);
 return args;
}
async function videoChecksum(ffmpeg,fileName,hashName){
 // FFmpeg's hash muxer hashes compressed video packets because -c:v copy is used.
 const code=await ffmpeg.exec(['-hide_banner','-loglevel','error','-i',fileName,'-map','0:v:0','-an','-c:v','copy','-f','hash','-hash','SHA256',hashName]);
 if(code!==0)throw new Error('Перевірка контрольної суми недоступна для цього відео.');
 const data=await ffmpeg.readFile(hashName);
 const hash=new TextDecoder().decode(data).trim().match(/SHA256=([a-f0-9]{64})/i)?.[1];
 if(!hash)throw new Error('Не вдалося прочитати SHA-256 відеопотоку.');
 return hash.toLowerCase();
}
async function determineHasAudio(ffmpeg,videoName){
 state.logs.length=0;
 // The -i command intentionally returns non-zero. We inspect its stream listing.
 await ffmpeg.exec(['-hide_banner','-i',videoName]);
 const text=state.logs.join('\n');
 const hasAudio=/Stream #\d+:\d+(?:\[[^\]]+\])?(?:\([^)]*\))?: Audio:/i.test(text);
 const hasVideo=/Stream #\d+:\d+(?:\[[^\]]+\])?(?:\([^)]*\))?: Video:/i.test(text);
 if(!hasVideo)throw new Error('FFmpeg не знайшов відеопотоку у файлі.');
 return hasAudio;
}
async function exportVideo(){
 if(state.busy||!state.video||!state.tracks.length)return;
 state.busy=true;state.cancelled=false;state.logs.length=0;enableUI();
 $('cancelBtn').hidden=false;$('retryBtn').hidden=true;$('downloadLink').hidden=true;
 if(state.outputURL){URL.revokeObjectURL(state.outputURL);state.outputURL=null;}
 $('video').pause();stopAllAudio();stopSample();
 const video=state.video;const tracks=state.tracks.map(t=>({...t}));
 let ffmpeg,videoName='',names=[],outputName='';
 try{
  setExportStatus('Підготовка','Копіюємо відеопотік без повторного стиснення.',1);
  if(!$('verifyQuality').checked&&window.soundLayerFastExport){
   try{
    const fast=await window.soundLayerFastExport({
      video,tracks,sources:state.sources,
      keepOriginal:$('originalToggle').checked,
      originalVolume:Number($('originalVolume').value)/100,
      cancelled:()=>state.cancelled,
      onProgress:(title,message,progress)=>setExportStatus(title,message,progress)
    });
    if(state.cancelled)throw new Error('Скасовано');
    state.outputURL=URL.createObjectURL(fast.blob);
    const link=$('downloadLink');link.href=state.outputURL;
    link.download=video.file.name.replace(/\.[^.]+$/,'')+`-soundlayer.${fast.format}`;
    link.hidden=false;
    setExportStatus('Відео готове',`Швидкий експорт: вихідні стиснуті відеокадри перенесено без декодування або перекодування. SHA-256 не обчислювався. Формат: ${fast.format.toUpperCase()}.`,100);
    return;
   }catch(fastError){
    if(state.cancelled)throw fastError;
    console.warn('Fast export unavailable, falling back to FFmpeg.wasm:',fastError);
    setExportStatus('Запасний режим',`Швидкий шлях недоступний (${fastError.message}). Використовуємо FFmpeg.wasm; це може зайняти більше часу.`,4);
   }
  }
  if($('verifyQuality').checked)setExportStatus('Контроль якості','Обрано SHA-256: необхідний повільніший FFmpeg.wasm, навіть якщо швидкий режим доступний.',5);
  if(video.file.size>450*1048576)throw new Error('FFmpeg.wasm може вичерпати пам’ять на файлах понад 450 МБ. Для великих відео потрібен підтримуваний швидкий режим у Chromium/Edge без SHA-перевірки.');
  ffmpeg=await ensureEngine();
  if(state.cancelled)throw new Error('Експорт скасовано.');
  videoName=`soundlayer-input.${extFor(video.file.name,'mp4')}`;
  setExportStatus('Читання відео','Передаємо вихідний файл у пам’ять FFmpeg.wasm…',26);
  await ffmpeg.writeFile(videoName,new Uint8Array(await video.file.arrayBuffer()));
  if(state.cancelled)throw new Error('Експорт скасовано.');
  setExportStatus('Перевірка аудіопотоку','Визначаємо, чи є звук у вихідному відео…',30);
  const hasAudio=await determineHasAudio(ffmpeg,videoName);
  state.originalAudioKnown=hasAudio;
  $('originalToggle').disabled=!hasAudio;
  if(!hasAudio){$('originalToggle').checked=false;setOriginalAudio();}
  const keepOriginal=hasAudio&&$('originalToggle').checked;
  for(let i=0;i<tracks.length;i++){
   if(state.cancelled)throw new Error('Експорт скасовано.');
   const src=state.sources.get(tracks[i].sourceId);
   if(!src)throw new Error('Не знайдено джерело аудіодоріжки.');
   const input=`sound-${i}.${src.builtIn?'ogg':extFor(src.file?.name||'audio.mp3','mp3')}`;
   names.push(input);
   setExportStatus('Підготовка звуків',`Аудіодоріжка ${i+1} з ${tracks.length}…`,30+Math.round((i/tracks.length)*5));
   await ffmpeg.writeFile(input,new Uint8Array(await sourceBytes(src)));
  }
  const primaryFormat=typeFor(video.file.name);
  let format=primaryFormat;let success=false;
  for(let attempt=0;attempt<2;attempt++){
   if(state.cancelled)throw new Error('Експорт скасовано.');
   outputName=`soundlayer-output.${format}`;
   setExportStatus('Накладання звуку',`Змішуємо ${tracks.length} доріжок. Відео копіюється без перекодування (${format.toUpperCase()}).`,35);
   state.logs.length=0;
   const args=buildCommand({videoName,trackNames:names,tracks,videoDuration:video.duration,hasOriginal:keepOriginal,format,output:outputName});
   const code=await ffmpeg.exec(args);
   if(code===0){success=true;break;}
   try{await ffmpeg.deleteFile(outputName);}catch(_){}
   if(format==='mkv')break;
   format='mkv';
   setExportStatus('Альтернативний контейнер',`Відеопотік несумісний із ${primaryFormat.toUpperCase()} або аудіокодек недоступний. Спробуємо MKV без перекодування кадрів.`,35);
  }
  if(!success)throw new Error('FFmpeg не зміг завершити експорт. Перевірте формат файлів і кількість доступної пам’яті.');
  if($('verifyQuality').checked){
  setExportStatus('Перевірка відеопотоку','Звіряємо SHA-256 закодованих відеоданих до і після експорту…',95);
  try{
   const originalHash=await videoChecksum(ffmpeg,videoName,'original.sha256');
   const outputHash=await videoChecksum(ffmpeg,outputName,'result.sha256');
   if(originalHash!==outputHash)throw new Error('SHA-256 відеопотоків не збіглися. Не можемо гарантувати ідентичність відеокадрів.');
   state.checksumVerified=true;
  }catch(error){
   if(error.message.includes('не збіглися'))throw error;
   state.checksumVerified=false;
   // The copy codec still prevents re-encoding when hash muxer is unavailable.
   console.warn('Video checksum unavailable:',error);
  }
  }else state.checksumVerified=false;
  setExportStatus('Фіналізація','Готуємо файл для завантаження…',97);
  const result=await ffmpeg.readFile(outputName);
  if(state.cancelled)throw new Error('Експорт скасовано.');
  const mime=format==='mp4'?'video/mp4':format==='webm'?'video/webm':'video/x-matroska';
  state.outputURL=URL.createObjectURL(new Blob([result],{type:mime}));
  const link=$('downloadLink');link.href=state.outputURL;
  link.download=video.file.name.replace(/\.[^.]+$/,'')+`-soundlayer.${format}`;
  link.hidden=false;
  setExportStatus('Відео готове',`Відеопотік скопійовано без перекодування (-c:v copy). ${state.checksumVerified?'SHA-256 збігаються.':$('verifyQuality').checked?'Додаткова перевірка SHA-256 недоступна.':'SHA-256 не обчислювався для пришвидшення.'} Формат: ${format.toUpperCase()}. Звук змонтовано окремо.`,100);
 }catch(e){
   if(state.cancelled||e?.name==='AbortError')setExportStatus('Експорт зупинено','Операцію скасовано. Ви можете змінити доріжки й спробувати знову.',0);
   else{
    const extra=state.logs.slice(-4).join(' · ').slice(0,400);
    setExportStatus('Помилка експорту',`${e.message||e}${extra?' Деталі: '+extra:''}`,0);
    $('exportInfo').classList.add('error');
    $('retryBtn').hidden=false;
    setEngineInfo('Не вдалося виконати експорт','Перевірте інтернет, формат відео та обсяг доступної пам’яті браузера.',true);
   }
 }finally{
   if(ffmpeg?.loaded){
    for(const name of [videoName,...names,outputName,'original.sha256','result.sha256'].filter(Boolean))try{await ffmpeg.deleteFile(name);}catch(_){}
   }
   state.busy=false;$('cancelBtn').hidden=true;enableUI();
 }
}
function cancelExport(){if(!state.busy)return;
 state.cancelled=true;
 state.engineController?.abort();
 if(state.ffmpeg){state.ffmpeg.terminate();state.ffmpeg=null;}
 if(state.pendingFFmpeg){state.pendingFFmpeg.terminate();state.pendingFFmpeg=null;}
 setExportStatus('Зупиняємо експорт','Звільняємо ресурси браузера…',0);
}
function dropSupport(el,kind){
 el.addEventListener('dragover',e=>{e.preventDefault();el.classList.add('dragover');});
 el.addEventListener('dragleave',e=>{if(!el.contains(e.relatedTarget))el.classList.remove('dragover');});
 el.addEventListener('drop',e=>{e.preventDefault();el.classList.remove('dragover');const files=e.dataTransfer.files;if(files?.length){if(kind==='video')loadVideo(files[0]);else loadAudios(files);}});
}
$('chooseVideo').addEventListener('click',e=>{e.stopPropagation();$('videoFile').click();});
$('replaceVideo').addEventListener('click',()=>$('videoFile').click());
$('videoFile').addEventListener('change',e=>{if(e.target.files.length)loadVideo(e.target.files[0]);e.target.value='';});
$('videoDrop').addEventListener('click',e=>{if(!state.video&&e.target.id!=='chooseVideo')$('videoFile').click();});
$('videoDrop').addEventListener('keydown',e=>{if(!state.video&&(e.key==='Enter'||e.key===' ')){e.preventDefault();$('videoFile').click();}});
$('audioDrop').addEventListener('click',()=>$('audioFile').click());
$('audioDrop').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('audioFile').click();}});
$('audioFile').addEventListener('change',e=>{if(e.target.files.length)loadAudios(e.target.files);e.target.value='';});
dropSupport($('videoDrop'),'video');dropSupport($('audioDrop'),'audio');
$('originalToggle').addEventListener('change',setOriginalAudio);
$('originalVolume').addEventListener('input',setOriginalAudio);
$('crossfade').addEventListener('input',e=>{state.transition=Number(e.target.value);$('crossfadeLabel').textContent=state.transition+' с';});
$('autoFade').addEventListener('click',autoFade);
$('exportBtn').addEventListener('click',exportVideo);
$('cancelBtn').addEventListener('click',cancelExport);
$('retryBtn').addEventListener('click',exportVideo);
$('video').addEventListener('play',()=>{if(sampleAudio)stopSample();syncAudios();if(previewTimer)clearInterval(previewTimer);previewTimer=setInterval(syncAudios,120);});
$('video').addEventListener('pause',()=>{if(previewTimer)clearInterval(previewTimer);previewTimer=null;stopAllAudio();});
$('video').addEventListener('ended',()=>{if(previewTimer)clearInterval(previewTimer);previewTimer=null;stopAllAudio();});
$('video').addEventListener('seeked',syncAudios);
$('helpBtn').addEventListener('click',()=>$('helpDialog').showModal());
$('closeHelp').addEventListener('click',()=>$('helpDialog').close());
$('helpDialog').addEventListener('click',e=>{if(e.target===$('helpDialog'))$('helpDialog').close();});
window.addEventListener('pagehide',()=>{if(state.outputURL)URL.revokeObjectURL(state.outputURL);});
init();