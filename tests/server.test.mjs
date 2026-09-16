import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {handleRequest,normalize,search} from '../server.mjs';
const req=(pathname,options)=>new Request('http://localhost:3030'+pathname,options);
const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
process.env.AUDIUS_BEARER_TOKEN='test-token-only';
process.env.JAMENDO_CLIENT_ID='test-id-only';
test('config only reports connection flags and secrets are not static files',async()=>{
  const config=await (await handleRequest(req('/api/config'))).json();
  assert.deepEqual(config,{audius:true,jamendo:true});
  for(const file of ['/config.json','/.env','/server.mjs','/../config.json']) assert.equal((await handleRequest(req(file))).status,404);
});
test('cross-origin settings and invalid host requests are blocked',async()=>{
  assert.equal((await handleRequest(req('/api/config',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:'{}'}))).status,403);
  assert.equal((await handleRequest(new Request('http://evil.example/api/config'))).status,403);
});
test('Audius search encodes query, keeps token server-side, and excludes gated tracks',async()=>{
  const result=await search('audius','Telugu & melody',async(url,options)=>{
    assert.equal(url.hostname,'api.audius.co');assert.equal(url.pathname,'/v1/tracks/search');assert.equal(url.searchParams.get('query'),'Telugu & melody');assert.equal(options.headers.Authorization,'Bearer test-token-only');
    return json({data:[{id:'abc',title:'Song',user:{name:'Artist'},duration:90,permalink:'/artist/song'},{id:'def',is_stream_gated:true},{id:'ghi',access_authorities:['authority']},{id:'jkl',access:{stream:false}}]});
  });
  assert.equal(result.tracks.length,1);assert.equal(result.excluded,3);assert.equal(result.tracks[0].url,'https://audius.co/artist/song');assert.ok(!JSON.stringify(result).includes('test-token'));
});
test('Jamendo search includes singles and albums and preserves stream eligibility',async()=>{
  const result=await search('jamendo','piano',async url=>{
    assert.equal(url.searchParams.get('client_id'),'test-id-only');assert.equal(url.searchParams.get('type'),'single albumtrack');assert.equal(url.searchParams.get('search'),'piano');
    return json({headers:{status:'success'},results:[{id:'123',name:'Piano',artist_name:'Artist',audio:'https://example.org/audio.mp3'},{id:'456',audio:''}]});
  });assert.equal(result.tracks.length,1);assert.equal(result.excluded,1);
});
test('invalid provider and rate limits return actionable errors',async()=>{
  assert.equal((await handleRequest(req('/api/search?provider=invalid'))).status,400);
  const r=await handleRequest(req('/api/search?provider=audius'),async()=>new Response('',{status:429}));assert.equal(r.status,429);assert.match((await r.json()).error,/limit/);
});
test('streaming rechecks gates before requesting audio',async()=>{
  let count=0;const r=await handleRequest(req('/api/stream/audius/abc'),async()=>{count++;return json({data:[{id:'abc',is_stream_gated:true}]});});assert.equal(r.status,403);assert.equal(count,1);
});
test('streaming carries byte ranges and partial content without leaking credentials',async()=>{
  let count=0;const r=await handleRequest(req('/api/stream/audius/abc',{headers:{Range:'bytes=0-3'}}),async(url,options)=>{
    if(++count===1)return json({data:[{id:'abc',title:'Track'}]});
    assert.equal(String(url),'https://api.audius.co/v1/tracks/abc/stream');assert.equal(options.headers.Range,'bytes=0-3');
    return new Response('test',{status:206,headers:{'Content-Type':'audio/mpeg','Content-Range':'bytes 0-3/10','Accept-Ranges':'bytes'}});
  });assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 0-3/10');assert.equal(await r.text(),'test');assert.equal(r.headers.get('Authorization'),null);
});
test('non-HTTPS provider artwork and links are discarded',()=>{const t=normalize('jamendo',{id:'1',image:'javascript:alert(1)',shareurl:'http://example.com',audio:'https://example.com/a.mp3'});assert.equal(t.art,'');assert.equal(t.url,'');});
test('HTML assets exist and are served with correct content types',async()=>{
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');assert.match(html,/data-import/);
  for(const [url,type] of [['/','text/html'],['/app.js','text/javascript'],['/styles.css','text/css'],['/library.js','text/javascript']]) {const r=await handleRequest(req(url));assert.equal(r.status,200);assert.ok(r.headers.get('content-type').startsWith(type));}
});
