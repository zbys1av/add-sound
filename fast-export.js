/* SoundLayer fast path. Pure-browser remux: encoded video packets are copied verbatim.
 * Audio is mixed in short OfflineAudioContext blocks and encoded with WebCodecs.
 * If a format/codec isn't supported, app.js falls back to FFmpeg.wasm. */
'use strict';
window.soundLayerFastExport = async ({video,tracks,sources,keepOriginal,originalVolume,cancelled,onProgress}) => {
  if(typeof AudioEncoder==='undefined'||typeof OfflineAudioContext==='undefined')throw new Error('WebCodecs AudioEncoder або OfflineAudioContext недоступні');
  const m=await import('https://cdn.jsdelivr.net/npm/mediabunny@1.65.0/+esm');
  if(cancelled())throw new Error('Скасовано');
  const input=new m.Input({formats:m.ALL_FORMATS,source:new m.BlobSource(video.file)});
  const vTrack=await input.getPrimaryVideoTrack();
  if(!vTrack)throw new Error('Відеопотоку не знайдено');
  const codec=await vTrack.getCodec();
  const videoConfig=await vTrack.getDecoderConfig();
  if(!codec||!videoConfig)throw new Error('Невідомий відеокодек');
  const ext=(video.file.name.split('.').pop()||'').toLowerCase();
  const opts=ext==='webm'?[['webm',new m.WebMOutputFormat(),'opus']]:
    ['mp4','m4v','mov'].includes(ext)?[['mp4',new m.Mp4OutputFormat({fastStart:false}),'aac']]:
    [['mkv',new m.MkvOutputFormat(),'opus']];
  const [format,formatObj,audioCodec]=opts[0];
  if(!formatObj.getSupportedVideoCodecs().includes(codec))throw new Error('Вихідний контейнер не підтримує цей відеокодек');
  if(!await m.canEncodeAudio(audioCodec,{sampleRate:48000,numberOfChannels:2}))throw new Error('Браузер не має потрібного швидкого аудіокодека');
  const ac=new (window.AudioContext||window.webkitAudioContext)();
  const srcBuffers=new Map();
  try{
    onProgress('Підготовка аудіо','Декодування звуків у браузері…',12);
    for(const t of tracks){
      if(srcBuffers.has(t.sourceId))continue;
      const src=sources.get(t.sourceId);if(!src)throw new Error('Немає звукового файлу');
      const bytes=src.file?await src.file.arrayBuffer():await (async()=>{
        try{const response=await fetch(src.url,{mode:'cors'});if(!response.ok)throw new Error('Звук недоступний');return response.arrayBuffer();}
        catch(err){if(!src.fallbackUrl)throw err;return (await fetch(src.fallbackUrl)).arrayBuffer();}
      })();
      srcBuffers.set(t.sourceId,await ac.decodeAudioData(bytes));
      if(cancelled())throw new Error('Скасовано');
    }
    const orig=keepOriginal?await input.getPrimaryAudioTrack():null;
    const origSink=orig?new m.AudioBufferSink(orig):null;
    const target=new m.BufferTarget();
    const output=new m.Output({format:formatObj,target});
    const vSource=new m.EncodedVideoPacketSource(codec);
    const aSource=new m.AudioBufferSource({codec:audioCodec,quality:new m.Quality({bitrate:160000})});
    output.addVideoTrack(vSource);
    output.addAudioTrack(aSource);
    await output.start();
    const duration=video.duration;
    // Chunked mixing prevents full-video PCM allocation (20 sec ~7.7 MB).
    const chunkSize=20;
    const schedule=(ctx,buffer,when,offset,length,gain=1,fadeIn=0,fadeOut=0,totalDuration=length)=>{
      if(length<=.0001||when>=ctx.length/ctx.sampleRate||when+length<=0)return;
      const start=Math.max(0,when), crop=Math.max(0,-when),actual=Math.min(length-crop,ctx.length/ctx.sampleRate-start);
      if(actual<=.0001)return;
      const node=ctx.createBufferSource();node.buffer=buffer;
      const gn=ctx.createGain();gn.gain.value=gain;
      node.connect(gn);gn.connect(ctx.destination);
      // Track fades in global timeline time, not chunk time.
      const begin=offset+crop, end=begin+actual;
      const envelope=(x)=>{
        let v=gain;
        if(fadeIn>0)v*=Math.min(1,Math.max(0,x/fadeIn));
        if(fadeOut>0)v*=Math.min(1,Math.max(0,(totalDuration-x)/fadeOut));
        return Math.max(0,v);
      };
      gn.gain.setValueAtTime(envelope(begin),start);
      const points=[begin,end];
      if(fadeIn>begin&&fadeIn<end)points.push(fadeIn);
      if(totalDuration-fadeOut>begin&&totalDuration-fadeOut<end)points.push(totalDuration-fadeOut);
      for(const x of points.sort((a,b)=>a-b).slice(1))gn.gain.linearRampToValueAtTime(envelope(x),start+(x-begin));
      node.start(start,Math.max(0,offset+crop),actual);
    };
    const feedAudio=async()=>{
      for(let start=0;start<duration;start+=chunkSize){
        if(cancelled())throw new Error('Скасовано');
        const seconds=Math.min(chunkSize,duration-start);
        const ctx=new OfflineAudioContext(2,Math.ceil(seconds*48000),48000);
        if(origSink){
          for await(const {buffer,timestamp} of origSink.buffers(start,start+seconds)){
            const delta=timestamp-start;const startInBuffer=Math.max(0,-delta);
            schedule(ctx,buffer,Math.max(0,delta),startInBuffer,Math.min(buffer.duration-startInBuffer,seconds-Math.max(0,delta)),originalVolume);
          }
        }
        for(const track of tracks){
          const audio=srcBuffers.get(track.sourceId);if(!audio)continue;
          const natural=audio.duration;
          const first=start-track.start,last=start+seconds-track.start;
          if(last<=0||first>=track.duration)continue;
          if(track.loop){
            // Smooth each loop seam. Slight overlap to avoid abrupt repeated-sample clicks.
            const overlap=Math.min(.12,natural*.06);
            const period=Math.max(.01,natural-overlap);
            const kMin=Math.max(0,Math.floor((first-natural)/period));
            const kMax=Math.ceil(last/period);
            for(let k=kMin;k<=kMax;k++){
              const pos=k*period;
              if(pos>=track.duration)break;
              const countLen=Math.min(natural,track.duration-pos);
              const sound=ctx.createBufferSource();sound.buffer=audio;
              const gain=ctx.createGain();sound.connect(gain);gain.connect(ctx.destination);
              const inChunk=track.start+pos-start;
              const offset=Math.max(0,-inChunk);const playAt=Math.max(0,inChunk);
              const playLen=Math.min(countLen-offset,seconds-playAt);
              if(playLen<=.0001)continue;
              const envelope=x=>{
                const t=pos+x;let vol=track.volume/100;
                if(track.fadeIn)vol*=Math.min(1,Math.max(0,t/track.fadeIn));
                if(track.fadeOut)vol*=Math.min(1,Math.max(0,(track.duration-t)/track.fadeOut));
                if(k>0&&overlap)vol*=Math.min(1,x/overlap);
                if(pos+natural<track.duration&&overlap)vol*=Math.min(1,(natural-x)/overlap);
                return Math.max(0,vol);
              };
              gain.gain.setValueAtTime(envelope(offset),playAt);
              const controlPoints=[offset+playLen];
              for(const x of [overlap, natural-overlap,track.fadeIn-pos,track.duration-track.fadeOut-pos])if(x>offset&&x<offset+playLen)controlPoints.push(x);
              for(const x of controlPoints.sort((a,b)=>a-b))gain.gain.linearRampToValueAtTime(envelope(x),playAt+x-offset);
              sound.start(playAt,offset,playLen);
            }
          }else{
            const inChunk=track.start-start;
            const offset=Math.max(0,-inChunk);
            const when=Math.max(0,inChunk);
            schedule(ctx,audio,when,offset,Math.min(natural-offset,track.duration-offset,seconds-when),track.volume/100,track.fadeIn,track.fadeOut,track.duration);
          }
        }
        await aSource.add(await ctx.startRendering());
        onProgress('Швидке змішування звуку',`Аудіо ${Math.round((start+seconds)/duration*100)}%`,12+Math.round(38*(start+seconds)/duration));
      }
      aSource.close();
    };
    const feedVideo=async()=>{
      const sink=new m.EncodedPacketSink(vTrack);
      let first=true, n=0;
      for await(const pkt of sink.packets()){
        if(cancelled())throw new Error('Скасовано');
        await vSource.add(pkt,first?{decoderConfig:videoConfig}:undefined);
        first=false;
        if((++n%250)===0)onProgress('Копіювання відео','Кадри копіюються у вихідному кодеку, без стискання…',55);
      }
      if(first)throw new Error('У відео немає кадрів');
      vSource.close();
    };
    await Promise.all([feedAudio(),feedVideo()]);
    onProgress('Завершення експорту','Формуємо відеофайл…',94);
    await output.finalize();
    if(cancelled())throw new Error('Скасовано');
    if(!target.buffer)throw new Error('Порожній вихідний файл');
    return {blob:new Blob([target.buffer],{type:format==='mp4'?'video/mp4':format==='webm'?'video/webm':'video/x-matroska'}),format};
  }finally{await ac.close().catch(()=>{}); input.dispose?.();}
};