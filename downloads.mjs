// Downloads are saved as real .m4a files (with title, artist, album and cover embedded) in a folder on this computer.
// Default: <home>/Music/BHAAI Music. Override with BHAAI_MUSIC_DIR. The app keeps its bookkeeping in <folder>/.bhaai/.
import {createReadStream, createWriteStream} from 'node:fs';
import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';

const ID=/^[A-Za-z0-9_-]{11}$/;
const RESERVED=/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_ACTIVE=3;

export const musicDir=()=>path.resolve(process.env.BHAAI_MUSIC_DIR||process.env.SVARA_MUSIC_DIR||path.join(os.homedir(),'Music','BHAAI Music'));
const dataDir=()=>path.join(musicDir(),'.bhaai');
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const exists=async file=>{try{return (await stat(file)).isFile();}catch{return false;}};

/** A file name that is valid on Windows, macOS and Linux. */
export function safeFileName(text,fallback='Untitled') {
  let name=String(text||'').normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g,' ').replace(/\s+/g,' ').trim();
  name=Array.from(name).slice(0,120).join('').replace(/[. ]+$/,'').trim();
  if(!name) return fallback;
  return RESERVED.test(name.split('.')[0].trim())?'_'+name:name;
}

function cleanTrack(input) {
  if(!input||typeof input!=='object'||!ID.test(input.id)) return null;
  const text=(value,max=300)=>typeof value==='string'?value.slice(0,max):'';
  const link=value=>{try{const u=new URL(value);return u.protocol==='https:'&&value.length<=2000?u.href:'';}catch{return '';}};
  return {id:input.id,provider:'youtube',title:text(input.title)||'Untitled',artist:text(input.artist)||'Unknown artist',album:text(input.album),
    duration:Number.isFinite(input.duration)?Math.max(0,input.duration):0,art:link(input.art),thumb:link(input.thumb)};
}

/* ---------- index (<folder>/.bhaai/library.json) ---------- */
let index=null,indexFor=null,writing=Promise.resolve();
export function forgetIndex() {index=null;indexFor=null;}
async function loadIndex() {
  const dir=musicDir();
  if(index&&indexFor===dir) return index;
  try {
    const data=JSON.parse(await readFile(path.join(dataDir(),'library.json'),'utf8'));
    index=data&&typeof data.songs==='object'&&data.songs?data:{songs:{}};
  } catch {index={songs:{}};}
  indexFor=dir;
  return index;
}
function saveIndex() {
  const snapshot=JSON.stringify(index,null,2),file=path.join(dataDir(),'library.json');
  writing=writing.then(async()=>{
    await mkdir(dataDir(),{recursive:true});
    await writeFile(file+'.tmp',snapshot);
    await rename(file+'.tmp',file);
  }).catch(()=>{});
  return writing;
}
// Only plain file names inside the music folder, even if library.json was edited by hand.
const songPath=record=>path.join(musicDir(),path.basename(String(record.file||'')));
const publicRecord=r=>({id:r.id,track:r.track,file:r.file,size:r.size,savedAt:r.savedAt,cover:!!r.cover});

async function listSongs() {
  const data=await loadIndex();let changed=false;const songs=[];
  for(const record of Object.values(data.songs)) {
    try {songs.push(publicRecord({...record,size:(await stat(songPath(record))).size}));}
    catch {delete data.songs[record.id];changed=true;} // the file was deleted or moved outside the app
  }
  if(changed) await saveIndex();
  return songs.sort((a,b)=>b.savedAt-a.savedAt);
}

/* ---------- saving ---------- */
const inFlight=new Map();
let active=0;const waiting=[];
async function slot() {
  if(active<MAX_ACTIVE) {active++;return;}
  await new Promise(resolve=>waiting.push(resolve));
}
function release() {const next=waiting.shift();if(next)next();else active--;}

async function saveSong(track,deps,progress) {
  const data=await loadIndex(),dir=musicDir();
  const existing=data.songs[track.id];
  if(existing&&await exists(songPath(existing))) return existing;
  await slot();
  const tmp=path.join(dataDir(),'tmp',track.id+'.m4a');
  try {
    await mkdir(path.dirname(tmp),{recursive:true});
    const {upstream}=await deps.fetchSong(track.id);
    const total=Number(upstream.headers.get('content-length'))||0;let received=0;
    const counter=new Transform({transform(chunk,_encoding,done){received+=chunk.length;if(total)progress(Math.min(99,Math.floor(received/total*100)));done(null,chunk);}});
    await pipeline(Readable.fromWeb(upstream.body),counter,createWriteStream(tmp));
    if(total&&received<total) throw new Error('The download was interrupted. Try again.');

    let cover='';
    try {
      const source=track.art&&new URL(track.art);
      if(source&&deps.artHost(source.hostname)) {
        const image=await deps.fetcher(source,{signal:AbortSignal.timeout(15000)});
        if(image.ok&&(image.headers.get('content-type')||'').startsWith('image/')) {
          cover=path.join(dataDir(),'covers',track.id+'.jpg');
          await mkdir(path.dirname(cover),{recursive:true});
          await writeFile(cover,Buffer.from(await image.arrayBuffer()));
        } else await image.body?.cancel();
      }
    } catch {cover='';}
    // Embed title/artist/album/cover so the file looks right in any music player. A tagging failure still keeps the song.
    try {await deps.youtube('tag',JSON.stringify({path:tmp,title:track.title,artist:track.artist,album:track.album,cover}));} catch {}

    const base=safeFileName(`${track.artist} - ${track.title}`);
    let file=base+'.m4a';
    if(await exists(path.join(dir,file))) file=`${base} (${track.id}).m4a`;
    await rm(path.join(dir,file),{force:true});
    await rename(tmp,path.join(dir,file));
    const record={id:track.id,file,track,cover:!!cover,size:(await stat(path.join(dir,file))).size,savedAt:Date.now()};
    data.songs[track.id]=record;
    await saveIndex();
    return record;
  } finally {
    await rm(tmp,{force:true}).catch(()=>{});
    release();
  }
}

function saveWithProgress(track,deps) {
  const encoder=new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      const send=message=>{try{controller.enqueue(encoder.encode(JSON.stringify(message)+'\n'));}catch{}};
      let last=-1;
      try {
        if(!inFlight.has(track.id)) inFlight.set(track.id,saveSong(track,deps,p=>{if(p!==last){last=p;send({progress:p});}}).finally(()=>inFlight.delete(track.id)));
        send({done:true,song:publicRecord(await inFlight.get(track.id)),folder:musicDir()});
      } catch(error) {
        send({error:error.code==='ENOSPC'?'Your disk is full. Free up space and try again.':error.code==='EACCES'||error.code==='EPERM'?`BHAAI Music can't write to ${musicDir()}. Check the folder's permissions.`:error.message||'Download failed. Try again.'});
      }
      try {controller.close();} catch {}
    },
  }),{headers:{'Content-Type':'application/x-ndjson','Cache-Control':'no-store'}});
}

/* ---------- serving saved files ---------- */
async function serveFile(request,file,type) {
  let info;try{info=await stat(file);}catch{return json({error:'That download is missing. It may have been moved or deleted.'},404);}
  const range=/^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range')||'');
  const headers={'Content-Type':type,'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  if(!range||(!range[1]&&!range[2])) {
    return new Response(Readable.toWeb(createReadStream(file)),{headers:{...headers,'Content-Length':String(info.size)}});
  }
  let start=range[1]?Number(range[1]):Math.max(0,info.size-Number(range[2]));
  let end=range[1]&&range[2]?Math.min(Number(range[2]),info.size-1):info.size-1;
  if(start>=info.size||start>end) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${info.size}`}});
  return new Response(Readable.toWeb(createReadStream(file,{start,end})),{status:206,headers:{...headers,'Content-Length':String(end-start+1),'Content-Range':`bytes ${start}-${end}/${info.size}`}});
}

function openFolder(dir) {
  const command=process.platform==='win32'?'explorer.exe':process.platform==='darwin'?'open':'xdg-open';
  try {spawn(command,[dir],{detached:true,stdio:'ignore',windowsHide:false}).on('error',()=>{}).unref();} catch {}
}

export async function handleDownloads(request,url,deps) {
  const writeAllowed=request.headers.get('origin')===url.origin;
  const parts=url.pathname.split('/').slice(3); // after /api/downloads
  if(!parts.length||(parts.length===1&&!parts[0])) {
    if(request.method==='GET') return json({folder:musicDir(),songs:await listSongs()});
    if(request.method!=='POST') return json({error:'Method not supported.'},405);
    if(!writeAllowed||!request.headers.get('content-type')?.startsWith('application/json')) return json({error:'Downloads can only be started from BHAAI Music.'},403);
    let track;try{track=cleanTrack(JSON.parse(await request.text()).track);}catch{track=null;}
    if(!track) return json({error:'Invalid song.'},400);
    return saveWithProgress(track,deps);
  }
  if(parts.length===1&&parts[0]==='open') {
    if(request.method!=='POST'||!writeAllowed) return json({error:'Method not supported.'},405);
    await mkdir(musicDir(),{recursive:true});
    openFolder(musicDir());
    return json({opened:true,folder:musicDir()});
  }
  const id=parts[0];
  if(!ID.test(id)||parts.length>2) return json({error:'Invalid song.'},400);
  const record=(await loadIndex()).songs[id];
  if(parts.length===1) {
    if(request.method!=='DELETE') return json({error:'Method not supported.'},405);
    if(!writeAllowed) return json({error:'Downloads can only be deleted from BHAAI Music.'},403);
    if(!record) return json({deleted:false});
    await rm(songPath(record),{force:true});
    await rm(path.join(dataDir(),'covers',id+'.jpg'),{force:true});
    delete index.songs[id];await saveIndex();
    return json({deleted:true});
  }
  if(request.method!=='GET') return json({error:'Method not supported.'},405);
  if(!record) return json({error:'That song isn’t downloaded.'},404);
  if(parts[1]==='audio') return serveFile(request,songPath(record),'audio/mp4');
  if(parts[1]==='art'&&record.cover) {
    const response=await serveFile(request,path.join(dataDir(),'covers',id+'.jpg'),'image/jpeg');
    if(response.ok) response.headers.set('Cache-Control','private, max-age=86400');
    return response;
  }
  return json({error:'Not found.'},404);
}
