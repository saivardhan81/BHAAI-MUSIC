// Library storage.
// - Imported and custom playlists live in this browser's IndexedDB.
// - Downloads are real .m4a files in a folder on this computer, managed by the local server (/api/downloads).
// - Older versions kept downloads inside IndexedDB ("offline" store); `legacy` lets the app move them to the folder.
(() => {
  let dbPromise;
  function open() {
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      let request;
      // Storage names ('svara' here, 'svara-*' in localStorage) predate the BHAAI Music name; keeping them keeps saved playlists.
      try {request=indexedDB.open('svara',1);} catch(error) {reject(error);return;}
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists',{keyPath:'id'});
        if(!db.objectStoreNames.contains('offline')) db.createObjectStore('offline',{keyPath:'id'});
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>{dbPromise=null;reject(request.error||new Error('Browser storage is unavailable.'));};
    });
    return dbPromise;
  }
  async function run(store,mode,operation) {
    const db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(store,mode);
      const request=operation(tx.objectStore(store));
      let result;
      request.onsuccess=()=>{result=request.result;};
      tx.oncomplete=()=>resolve(result);
      tx.onerror=tx.onabort=()=>reject(tx.error||new Error('Browser storage failed.'));
    });
  }
  const artURL=src=>src?'/api/art?src='+encodeURIComponent(src):'';
  async function request(path,options={}) {
    let response;
    try {response=await fetch(path,options);}
    catch {throw new Error('BHAAI Music’s server isn’t running. Start it with Start-Windows.bat, then refresh.');}
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error||'Something went wrong. Please try again.');
    return data;
  }

  window.BhaaiLibrary={
    artURL,
    playlists:{
      all:async()=>((await run('playlists','readonly',s=>s.getAll()))||[]).sort((a,b)=>b.addedAt-a.addedAt),
      put:playlist=>run('playlists','readwrite',s=>s.put(playlist)),
      remove:id=>run('playlists','readwrite',s=>s.delete(id)),
    },
    downloads:{
      list:()=>request('/api/downloads'),
      audioURL:id=>'/api/downloads/'+encodeURIComponent(id)+'/audio',
      coverURL:id=>'/api/downloads/'+encodeURIComponent(id)+'/art',
      remove:id=>request('/api/downloads/'+encodeURIComponent(id),{method:'DELETE'}),
      openFolder:()=>request('/api/downloads/open',{method:'POST'}),
      // The server streams one JSON line per progress update, then {done, song} or {error}.
      async save(track,onProgress=()=>{}) {
        let response;
        try {
          response=await fetch('/api/downloads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({track})});
        } catch {throw new Error('BHAAI Music’s server isn’t running. Start it with Start-Windows.bat, then refresh.');}
        if(!response.ok) {
          const data=await response.json().catch(()=>({}));
          throw new Error(data.error||'Download failed. Try again.');
        }
        const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer='';
        for(;;) {
          const {done,value}=await reader.read();
          if(value) buffer+=value;
          let newline;
          while((newline=buffer.indexOf('\n'))>=0) {
            const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
            if(!line.trim()) continue;
            const message=JSON.parse(line);
            if(message.error) throw new Error(message.error);
            if(message.done) return message;
            if(typeof message.progress==='number') onProgress(message.progress);
          }
          if(done) throw new Error('The download stopped unexpectedly. Try again.');
        }
      },
    },
    legacy:{
      async all() {
        try {return (await run('offline','readonly',s=>s.getAllKeys()))||[];} catch {return [];}
      },
      get:id=>run('offline','readonly',s=>s.get(id)),
      remove:id=>run('offline','readwrite',s=>s.delete(id)),
    },
  };
})();
