import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import path from 'node:path';
import {runYouTube} from './youtube.mjs';
import {handleDownloads,forgetIndex} from './downloads.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(root, 'config.json');
let config = {};
try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch {}
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const safeURL = value => { try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; } };
export function normalize(provider, t) {
  if (provider === 'audius') return {id:String(t.id),provider,title:t.title || 'Untitled',artist:t.user?.name || 'Unknown artist',duration:Number(t.duration)||0,art:safeURL(t.artwork?.['480x480']),url:safeURL(t.permalink?.startsWith('/') ? 'https://audius.co'+t.permalink : t.permalink),playable:!t.is_stream_gated && !t.is_premium && !t.is_delete && t.is_streamable!==false && t.access?.stream!==false && !(t.access_authorities?.length)};
  return {id:String(t.id),provider,title:t.name || 'Untitled',artist:t.artist_name || 'Unknown artist',duration:Number(t.duration)||0,art:safeURL(t.image),url:safeURL(t.shareurl),playable:!!safeURL(t.audio)};
}
function credentials(provider) {
  if (provider === 'audius') {
    const token = process.env.AUDIUS_BEARER_TOKEN || config.audiusToken;
    if (!token) throw Object.assign(new Error('Connect Audius in Music sources first. Its developer free tier provides the credentials.'),{status:428});
    return token;
  }
  const key = process.env.JAMENDO_CLIENT_ID || config.jamendoKey;
  if (!key) throw Object.assign(new Error('Connect Jamendo in Music sources first.'),{status:428});
  return key;
}
export async function providerJSON(provider, route, params={}, fetcher=fetch) {
  const credential=credentials(provider);
  const url = new URL(provider==='audius' ? 'https://api.audius.co/v1/'+route : 'https://api.jamendo.com/v3.0/tracks/');
  for(const [key,value] of Object.entries(params)) url.searchParams.set(key,String(value));
  if(provider==='jamendo') {url.searchParams.set('client_id',credential);url.searchParams.set('format','json');url.searchParams.set('audioformat','mp32');url.searchParams.set('type','single albumtrack');}
  const response=await fetcher(url,{headers:provider==='audius'?{Authorization:'Bearer '+credential}:{},signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw Object.assign(new Error(response.status===429?'Provider request limit reached. Try again later.':response.status===401||response.status===403?'Provider refused access. Check your credentials and track availability.':'Music provider is unavailable. Try again shortly.'),{status:response.status===429?429:502});
  const data=await response.json();
  if(provider==='jamendo' && data.headers?.status!=='success') throw new Error('Jamendo rejected this request. Check your client ID.');
  return data;
}
const searchCache=new Map();
const streamCache=new Map();
const artHosts=new Set(['lh3.googleusercontent.com','yt3.googleusercontent.com','yt3.ggpht.com','i.ytimg.com','i.scdn.co','mosaic.scdn.co','charts-images.scdn.co','image-cdn-ak.spotifycdn.com','image-cdn-fa.spotifycdn.com']);
const artHost=host=>artHosts.has(host)||/^is[1-5]-ssl\.mzstatic\.com$/.test(host);
const unplayable=()=>Object.assign(new Error('This song can’t be played right now. Try another one.'),{status:502});
function remember(cache,key,value,ttl) {
  if(cache.size>500) cache.delete(cache.keys().next().value);
  cache.set(key,{value,expires:Date.now()+ttl});
  return value;
}
function recall(cache,key) {
  const hit=cache.get(key);
  if(hit && hit.expires>Date.now()) return hit.value;
  cache.delete(key);
}
export function clearCaches() {searchCache.clear();streamCache.clear();forgetIndex();}
// Audio URLs are signed and expire (expire= parameter); refresh them five minutes early.
async function youtubeStream(id,youtube,fresh=false) {
  if(!fresh){const cached=recall(streamCache,id);if(cached)return cached;}
  const data=await youtube('stream',id);
  const url=safeURL(data.url);
  if(!url || !new URL(url).hostname.endsWith('.googlevideo.com')) throw unplayable();
  const expire=Number(new URL(url).searchParams.get('expire'))*1000;
  const ttl=expire>Date.now()?Math.min(expire-Date.now()-300000,5*3600000):1800000;
  return remember(streamCache,id,{url,mime:data.mime==='audio/webm'?'audio/webm':'audio/mp4'},Math.max(ttl,60000));
}
function proxyStream(request,fetcher,target,headers={}) {
  if(request.headers.has('range')) headers={...headers,Range:request.headers.get('range')};
  return fetcher(target,{headers,signal:AbortSignal.timeout(120000),redirect:'follow'});
}
// Resolves (and if needed re-resolves) a song's audio URL and opens it. Throws when the song can't be fetched.
async function fetchYouTubeAudio(id,range,fetcher,youtube) {
  // Google throttles audio requests without a byte range to real-time speed, so always ask for one.
  const headers={Range:range||'bytes=0-'};
  const open=url=>fetcher(url,{headers,signal:AbortSignal.timeout(120000),redirect:'follow'});
  let resolved=await youtubeStream(id,youtube);
  let upstream=await open(resolved.url);
  if(upstream.status===403 || upstream.status===410) {
    await upstream.body?.cancel();
    resolved=await youtubeStream(id,youtube,true);
    upstream=await open(resolved.url);
  }
  if(!upstream.ok && upstream.status!==416) {await upstream.body?.cancel();streamCache.delete(id);throw unplayable();}
  return {upstream,mime:resolved.mime};
}
function streamResponse(upstream,mime) {
  const responseHeaders={'Cache-Control':'no-store'};
  for(const name of ['content-type','content-length','content-range','accept-ranges']) if(upstream.headers.has(name)) responseHeaders[name]=upstream.headers.get(name);
  if(mime && !responseHeaders['content-type']?.startsWith('audio/')) responseHeaders['content-type']=mime;
  return new Response(upstream.body,{status:upstream.status,headers:responseHeaders});
}
export async function search(provider, query='', fetcher=fetch, youtube=runYouTube) {
  if(provider==='youtube') {
    const key=query.trim().toLowerCase();
    return recall(searchCache,key) || remember(searchCache,key,await youtube('search',query),15*60000);
  }
  if(!['audius','jamendo'].includes(provider)) throw Object.assign(new Error('Unknown music source.'),{status:400});
  const data=await providerJSON(provider,query?'tracks/search':'tracks/trending',provider==='audius'?{limit:40,...(query?{query}:{time:'week'})}:{limit:40,...(query?{search:query}:{order:'popularity_week'})},fetcher);
  const items=(provider==='audius'?data.data:data.results)||[];
  if(!Array.isArray(items)) throw new Error('Unexpected response from the music provider.');
  const normalized=items.map(t=>normalize(provider,t)).filter(t=>t.playable);
  return {tracks:normalized,excluded:items.length-normalized.length};
}
export async function handleRequest(request, fetcher=fetch, youtube=runYouTube) {
  const url=new URL(request.url);
  if(!['localhost','127.0.0.1'].includes(url.hostname)) return json({error:'Local access only.'},403);
  const origin=request.headers.get('origin');
  if(origin && origin!==url.origin) return json({error:'Cross-origin access is not allowed.'},403);
  try {
    if(url.pathname==='/api/config') {
      if(request.method==='GET') return json({audius:!!(config.audiusToken||process.env.AUDIUS_BEARER_TOKEN),jamendo:!!(config.jamendoKey||process.env.JAMENDO_CLIENT_ID)});
      if(request.method!=='POST' || origin!==url.origin || !request.headers.get('content-type')?.startsWith('application/json')) return json({error:'Use the local Music sources form.'},403);
      const body=await request.text();if(body.length>5000) return json({error:'Settings are too large.'},400);
      const input=JSON.parse(body);const next={...config};
      for(const key of ['audiusToken','jamendoKey']) if(typeof input[key]==='string' && input[key].trim()) next[key]=input[key].trim();
      await writeFile(configPath,JSON.stringify(next,null,2),{mode:0o600});config=next;
      return json({saved:true});
    }
    if(url.pathname==='/api/downloads' || url.pathname.startsWith('/api/downloads/')) {
      return await handleDownloads(request,url,{
        fetcher,youtube,artHost,
        fetchSong:id=>fetchYouTubeAudio(id,null,fetcher,youtube),
      });
    }
    if(request.method!=='GET') return json({error:'Method not supported.'},405);
    if(url.pathname==='/api/youtube/status') return json(await youtube('status'));
    if(url.pathname==='/api/playlist') {
      const link=(url.searchParams.get('url')||'').trim();
      if(!link || link.length>500) return json({error:'Paste a playlist link from YouTube Music, Spotify, or Apple Music.'},400);
      return json(await youtube('playlist',link));
    }
    if(url.pathname==='/api/art') {
      let source;try{source=new URL(url.searchParams.get('src')||'');}catch{return json({error:'Invalid artwork.'},400);}
      if(source.protocol!=='https:' || !artHost(source.hostname)) return json({error:'Invalid artwork.'},400);
      let upstream=await fetcher(source,{signal:AbortSignal.timeout(15000)});
      // Not every video has a 720p thumbnail; fall back to the medium one (also bar-free).
      if(upstream.status===404 && source.hostname==='i.ytimg.com' && source.pathname.endsWith('/hq720.jpg')) {
        await upstream.body?.cancel();
        upstream=await fetcher(new URL(source.href.replace('/hq720.jpg','/mqdefault.jpg')),{signal:AbortSignal.timeout(15000)});
      }
      const type=upstream.headers.get('content-type')||'';
      if(!upstream.ok || !type.startsWith('image/')) {await upstream.body?.cancel();return json({error:'Artwork unavailable.'},404);}
      return new Response(upstream.body,{headers:{'Content-Type':type,'Cache-Control':'public, max-age=604800','X-Content-Type-Options':'nosniff'}});
    }
    if(url.pathname==='/api/search') return json(await search(url.searchParams.get('provider')||'audius',(url.searchParams.get('q')||'').slice(0,200),fetcher,youtube));
    if(url.pathname.startsWith('/api/stream/')) {
      const song=url.pathname.match(/^\/api\/stream\/youtube\/([A-Za-z0-9_-]{11})$/);
      if(song) {
        const whole=!request.headers.has('range');
        const {upstream,mime}=await fetchYouTubeAudio(song[1],request.headers.get('range'),fetcher,youtube);
        if(upstream.status===416) {await upstream.body?.cancel();return json({error:'Invalid range.'},416);}
        const response=streamResponse(upstream,mime);
        if(!whole || upstream.status!==206) return response;
        const headers=new Headers(response.headers);headers.delete('content-range');
        return new Response(response.body,{status:200,headers});
      }
      const match=url.pathname.match(/^\/api\/stream\/(audius|jamendo)\/([a-zA-Z0-9_-]+)$/);
      if(!match) return json({error:'Invalid track.'},400);
      const [,provider,id]=match;let streamURL;let headers={};
      if(provider==='audius') {
        const data=await providerJSON(provider,'tracks/'+id,{},fetcher);
        const track=Array.isArray(data.data)?data.data[0]:data.data;
        if(!track || !normalize(provider,track).playable) return json({error:'This track is not available for free streaming.'},403);
        streamURL='https://api.audius.co/v1/tracks/'+id+'/stream';headers.Authorization='Bearer '+credentials(provider);
      } else {
        const data=await providerJSON(provider,'tracks',{id},fetcher);streamURL=safeURL(data.results?.[0]?.audio);
        if(!streamURL) return json({error:'This track has no available stream.'},404);
      }
      const upstream=await proxyStream(request,fetcher,streamURL,headers);
      if(!upstream.ok) {await upstream.body?.cancel();return json({error:'Playback unavailable for this track.'},upstream.status===416?416:502);}
      return streamResponse(upstream);
    }
    const files={'/':'index.html','/app.js':'app.js','/library.js':'library.js','/styles.css':'styles.css'};
    if(!files[url.pathname]) return json({error:'Not found.'},404);
    const file=files[url.pathname];return new Response(await readFile(path.join(root,'dist',file)),{headers:{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':'text/javascript','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'}});
  } catch(error) {
    return json({error:error.name==='TimeoutError'?'The music provider took too long. Try again.':error.message==='fetch failed'?'Cannot reach the music provider. Check your internet connection.':error.message},error.status||502);
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.BHAAI_PORT||process.env.SVARA_PORT)||3030;
  const server=http.createServer(async(req,res)=>{
    try {
      if(!['localhost:'+port,'127.0.0.1:'+port].includes(req.headers.host)) {res.writeHead(403);res.end('Local access only');return;}
      const chunks=[];let size=0;for await(const chunk of req) {size+=chunk.length;if(size>8192){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const request=new Request('http://'+req.headers.host+req.url,{method:req.method,headers:req.headers,...(req.method!=='GET'&&req.method!=='HEAD'?{body:Buffer.concat(chunks)}:{})});
      const response=await handleRequest(request);res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body){const stream=Readable.fromWeb(response.body);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);}else res.end();
    }catch{if(!res.headersSent)res.writeHead(500);res.end('Request failed');}
  });
  server.listen(port,'127.0.0.1',()=>console.log(`\nBHAAI Music is ready: http://localhost:${port}\nKeep this window open. Press Ctrl+C to stop.\n`));
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is already in use. Close the other BHAAI Music window and try again.`:error.message);process.exitCode=1;});
}
