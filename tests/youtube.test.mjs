import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest,clearCaches} from '../server.mjs';

const req=(pathname,options)=>new Request('http://localhost:3030'+pathname,options);
const audioURL='https://rr1---sn-test.googlevideo.com/videoplayback?expire='+Math.floor(Date.now()/1000+21600)+'&id=1';

test('YouTube route passes Unicode and punctuation to the bridge without shell interpolation',async()=>{
  clearCaches();
  const query='తెలుగు "song" & test';
  const result=await handleRequest(req('/api/search?'+new URLSearchParams({provider:'youtube',q:query})),undefined,async(action,input)=>{
    assert.equal(action,'search');assert.equal(input,query);return {tracks:[{id:'abcdefghijk',provider:'youtube'}],excluded:0};
  });assert.equal(result.status,200);assert.equal((await result.json()).tracks[0].provider,'youtube');
});
test('repeated searches are served from the cache',async()=>{
  clearCaches();let calls=0;
  const bridge=async()=>{calls++;return {tracks:[],excluded:0};};
  for(let i=0;i<3;i++) assert.equal((await handleRequest(req('/api/search?provider=youtube&q=Rahman'),undefined,bridge)).status,200);
  assert.equal(calls,1);
});
test('setup errors reach the app',async()=>{
  const result=await handleRequest(req('/api/youtube/status'),undefined,async()=>{throw Object.assign(new Error('Install ytmusicapi'),{status:428});});
  assert.equal(result.status,428);assert.equal((await result.json()).error,'Install ytmusicapi');
});
test('audio streams through the local server with byte ranges and a cached stream URL',async()=>{
  clearCaches();let resolves=0;const seen=[];
  const bridge=async(action,id)=>{assert.equal(action,'stream');assert.equal(id,'abcdefghijk');resolves++;return {url:audioURL,mime:'audio/mp4'};};
  const fetcher=async(url,options)=>{seen.push(options.headers.Range);assert.equal(String(url),audioURL);return new Response('abcd',{status:206,headers:{'Content-Type':'audio/mp4','Content-Range':'bytes 0-3/10','Content-Length':'4'}});};
  for(let i=0;i<2;i++) {
    const r=await handleRequest(req('/api/stream/youtube/abcdefghijk',{headers:{Range:'bytes=0-3'}}),fetcher,bridge);
    assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 0-3/10');assert.equal(await r.text(),'abcd');
    assert.ok(!r.headers.has('location'));
  }
  assert.equal(resolves,1);assert.deepEqual(seen,['bytes=0-3','bytes=0-3']);
});
test('whole-song requests still ask Google for a byte range to avoid throttling',async()=>{
  clearCaches();
  const fetcher=async(url,options)=>{assert.equal(options.headers.Range,'bytes=0-');return new Response('abcd',{status:206,headers:{'Content-Type':'audio/mp4','Content-Range':'bytes 0-3/4','Content-Length':'4'}});};
  const r=await handleRequest(req('/api/stream/youtube/abcdefghijk'),fetcher,async()=>({url:audioURL,mime:'audio/mp4'}));
  assert.equal(r.status,200);assert.equal(r.headers.get('content-range'),null);assert.equal(r.headers.get('content-length'),'4');assert.equal(await r.text(),'abcd');
});
test('an expired stream URL is resolved again once',async()=>{
  clearCaches();let resolves=0,fetches=0;
  const bridge=async()=>{resolves++;return {url:audioURL,mime:'audio/mp4'};};
  const fetcher=async()=>++fetches===1?new Response('',{status:403}):new Response('ok',{status:200,headers:{'Content-Type':'audio/mp4'}});
  const r=await handleRequest(req('/api/stream/youtube/abcdefghijk'),fetcher,bridge);
  assert.equal(r.status,200);assert.equal(resolves,2);assert.equal(fetches,2);
});
test('stream rejects bad IDs and non-Google audio hosts',async()=>{
  clearCaches();
  assert.equal((await handleRequest(req('/api/stream/youtube/bad'))).status,400);
  const r=await handleRequest(req('/api/stream/youtube/abcdefghijk'),async()=>{throw new Error('should not fetch');},async()=>({url:'https://evil.example/a.m4a'}));
  assert.equal(r.status,502);
});
test('playlist import validates input and returns bridge data',async()=>{
  assert.equal((await handleRequest(req('/api/playlist'))).status,400);
  const link='https://music.youtube.com/playlist?list=PLabcdefghijklmnop';
  const r=await handleRequest(req('/api/playlist?'+new URLSearchParams({url:link})),undefined,async(action,input)=>{assert.equal(action,'playlist');assert.equal(input,link);return {id:'PLabcdefghijklmnop',title:'Mine',tracks:[]};});
  assert.equal(r.status,200);assert.equal((await r.json()).title,'Mine');
});
test('artwork proxy only fetches Google image hosts',async()=>{
  assert.equal((await handleRequest(req('/api/art?src='+encodeURIComponent('https://evil.example/x.jpg')))).status,400);
  assert.equal((await handleRequest(req('/api/art?src='+encodeURIComponent('http://i.ytimg.com/vi/x/hq.jpg')))).status,400);
  assert.equal((await handleRequest(req('/api/art?src='+encodeURIComponent('https://is1-sslXmzstatic.com/x.jpg')))).status,400);
  for(const src of ['https://is3-ssl.mzstatic.com/image/thumb/a/1200x1200bb.jpg','https://i.scdn.co/image/abc']) {
    const ok=await handleRequest(req('/api/art?src='+encodeURIComponent(src)),async()=>new Response('img',{headers:{'Content-Type':'image/jpeg'}}));
    assert.equal(ok.status,200);
  }
  const r=await handleRequest(req('/api/art?src='+encodeURIComponent('https://lh3.googleusercontent.com/abc=w1200-h1200')),async()=>new Response('img',{headers:{'Content-Type':'image/jpeg'}}));
  assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/jpeg');
  const html=await handleRequest(req('/api/art?src='+encodeURIComponent('https://i.ytimg.com/x')),async()=>new Response('<html>',{headers:{'Content-Type':'text/html'}}));
  assert.equal(html.status,404);
});
