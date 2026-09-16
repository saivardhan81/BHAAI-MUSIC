import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {handleRequest,clearCaches} from '../server.mjs';
import {safeFileName} from '../downloads.mjs';

const origin='http://localhost:3030';
const req=(pathname,options={})=>new Request(origin+pathname,options);
const audioURL='https://rr1---sn-test.googlevideo.com/videoplayback?expire='+Math.floor(Date.now()/1000+21600);
const track={id:'abcdefghijk',title:'Samajavaragamana',artist:'Sid Sriram',album:'Ala Vaikunthapurramuloo',duration:220,art:'https://lh3.googleusercontent.com/x=w1200-h1200',thumb:''};
const audioBytes='0123456789abcdef';

async function withFolder(run) {
  const folder=await mkdtemp(path.join(os.tmpdir(),'bhaai-downloads-'));
  const previous=process.env.BHAAI_MUSIC_DIR;
  process.env.BHAAI_MUSIC_DIR=folder;clearCaches();
  try {await run(folder);}
  finally {
    if(previous===undefined) delete process.env.BHAAI_MUSIC_DIR;else process.env.BHAAI_MUSIC_DIR=previous;
    await rm(folder,{recursive:true,force:true});
  }
}
const fetcher=async url=>String(url).startsWith('https://rr1')
  ?new Response(audioBytes,{status:206,headers:{'Content-Type':'audio/mp4','Content-Length':String(audioBytes.length),'Content-Range':`bytes 0-15/16`}})
  :new Response('jpeg-bytes',{headers:{'Content-Type':'image/jpeg'}});
function bridge(calls) {
  return async(action,query)=>{
    calls.push([action,query]);
    if(action==='stream') return {url:audioURL,mime:'audio/mp4'};
    if(action==='tag') return {tagged:true};
    throw new Error('unexpected '+action);
  };
}
const startDownload=(body,headers={Origin:origin,'Content-Type':'application/json'})=>req('/api/downloads',{method:'POST',headers,body:JSON.stringify(body)});
const lines=async response=>(await response.text()).trim().split('\n').map(line=>JSON.parse(line));

test('file names are safe on Windows',()=>{
  assert.equal(safeFileName('AC/DC: Back <in> Black?'),'AC DC Back in Black');
  assert.equal(safeFileName('  Song name...  '),'Song name');
  assert.equal(safeFileName('CON'),'_CON');
  assert.equal(safeFileName('\u0000\u0007'),'Untitled');
  assert.equal(Array.from(safeFileName('స'.repeat(300))).length,120);
});

test('a download is saved as a tagged .m4a in the music folder, listed, played with ranges, and deleted',async()=>{
  await withFolder(async folder=>{
    const calls=[];const youtube=bridge(calls);
    const messages=await lines(await handleRequest(startDownload({track}),fetcher,youtube));
    const last=messages.at(-1);
    assert.equal(last.done,true);assert.equal(last.folder,folder);
    assert.equal(last.song.file,'Sid Sriram - Samajavaragamana.m4a');
    assert.ok(messages.some(m=>m.progress===99));
    assert.equal(await readFile(path.join(folder,last.song.file),'utf8'),audioBytes);
    const tag=JSON.parse(calls.find(([action])=>action==='tag')[1]);
    assert.equal(tag.title,'Samajavaragamana');assert.equal(tag.artist,'Sid Sriram');assert.ok(tag.cover.endsWith('abcdefghijk.jpg'));
    assert.deepEqual((await readdir(path.join(folder,'.bhaai','tmp'))),[]);

    const list=await (await handleRequest(req('/api/downloads'),fetcher,youtube)).json();
    assert.equal(list.songs.length,1);assert.equal(list.songs[0].track.title,'Samajavaragamana');assert.equal(list.songs[0].cover,true);

    const part=await handleRequest(req('/api/downloads/abcdefghijk/audio',{headers:{Range:'bytes=4-7'}}),fetcher,youtube);
    assert.equal(part.status,206);assert.equal(part.headers.get('content-range'),'bytes 4-7/16');assert.equal(await part.text(),'4567');
    assert.equal((await handleRequest(req('/api/downloads/abcdefghijk/audio',{headers:{Range:'bytes=99-'}}),fetcher,youtube)).status,416);
    assert.equal(await (await handleRequest(req('/api/downloads/abcdefghijk/art'),fetcher,youtube)).text(),'jpeg-bytes');

    // Saving the same song again reuses the file instead of downloading twice.
    const again=(await lines(await handleRequest(startDownload({track}),fetcher,youtube))).at(-1);
    assert.equal(again.song.file,last.song.file);assert.equal(calls.filter(([a])=>a==='stream').length,1);

    const deleted=await handleRequest(req('/api/downloads/abcdefghijk',{method:'DELETE',headers:{Origin:origin}}),fetcher,youtube);
    assert.equal((await deleted.json()).deleted,true);
    assert.deepEqual((await readdir(folder)).filter(name=>name.endsWith('.m4a')),[]);
  });
});

test('two different songs with the same name do not overwrite each other',async()=>{
  await withFolder(async folder=>{
    const youtube=bridge([]);
    await lines(await handleRequest(startDownload({track}),fetcher,youtube));
    const second=(await lines(await handleRequest(startDownload({track:{...track,id:'zyxwvutsrqp'}}),fetcher,youtube))).at(-1);
    assert.equal(second.song.file,'Sid Sriram - Samajavaragamana (zyxwvutsrqp).m4a');
    assert.equal((await readdir(folder)).filter(name=>name.endsWith('.m4a')).length,2);
  });
});

test('files removed outside the app disappear from the list, and hand-edited paths cannot escape the folder',async()=>{
  await withFolder(async folder=>{
    const youtube=bridge([]);
    const saved=(await lines(await handleRequest(startDownload({track}),fetcher,youtube))).at(-1);
    await rm(path.join(folder,saved.song.file));
    assert.equal((await (await handleRequest(req('/api/downloads'),fetcher,youtube)).json()).songs.length,0);

    const outside=path.join(path.dirname(folder),'bhaai-outside-'+Date.now()+'.m4a');
    await writeFile(outside,'secret');
    await writeFile(path.join(folder,'.bhaai','library.json'),JSON.stringify({songs:{abcdefghijk:{id:'abcdefghijk',file:'../'+path.basename(outside),track,savedAt:1}}}));
    clearCaches();
    const served=await handleRequest(req('/api/downloads/abcdefghijk/audio'),fetcher,youtube);
    assert.notEqual(await served.text(),'secret');
    await rm(outside,{force:true});
  });
});

test('downloads can only be started or deleted by the BHAAI Music page itself',async()=>{
  await withFolder(async()=>{
    const youtube=bridge([]);
    assert.equal((await handleRequest(startDownload({track},{'Content-Type':'application/json'}),fetcher,youtube)).status,403);
    assert.equal((await handleRequest(startDownload({track},{Origin:'https://evil.example','Content-Type':'application/json'}),fetcher,youtube)).status,403);
    assert.equal((await handleRequest(startDownload({track:{...track,id:'../../etc'}}),fetcher,youtube)).status,400);
    assert.equal((await handleRequest(req('/api/downloads/abcdefghijk',{method:'DELETE'}),fetcher,youtube)).status,403);
    assert.equal((await handleRequest(req('/api/downloads/open'),fetcher,youtube)).status,405);
  });
});

test('a failed download reports the error and leaves no partial file',async()=>{
  await withFolder(async folder=>{
    const youtube=async action=>{if(action==='stream')throw Object.assign(new Error('This song can’t be played right now. Try another one.'),{status:502});};
    const messages=await lines(await handleRequest(startDownload({track}),fetcher,youtube));
    assert.match(messages.at(-1).error,/can’t be played/);
    assert.deepEqual((await readdir(folder,{recursive:true})).filter(name=>name.endsWith('.m4a')),[]);
  });
});
