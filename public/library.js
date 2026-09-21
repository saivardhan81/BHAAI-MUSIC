// Library storage and API client.
// - Your own and imported playlists live in this browser's IndexedDB, on this device only.
// - Loved songs, recently played and volume live in localStorage (see app.js).
// - The API (api/index.py) searches YouTube Music, reads public playlist links, streams audio and builds MP3s. It stores nothing.
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
  async function request(path,{timeout=30000}={}) {
    let response;
    try {response=await fetch('/api/'+path,{signal:AbortSignal.timeout(timeout)});}
    catch(error) {throw new Error(error.name==='TimeoutError'?'That took too long. Please try again.':'Can’t reach BHAAI Music. Check your internet connection.');}
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error||'Something went wrong. Please try again.');
    return data;
  }

  window.BhaaiLibrary={
    search:q=>request('search?'+new URLSearchParams({q}),{timeout:40000}),
    // Spotify/Apple links match every song on YouTube Music first, which can take up to a minute.
    readPlaylist:url=>request('playlist?'+new URLSearchParams({url}),{timeout:90000}),
    // The server converts the song to a tagged MP3 (with its cover); the browser then saves the file on this device.
    async downloadMP3(track) {
      const params=new URLSearchParams({title:track.title,artist:track.artist,album:track.album||'',art:track.art||''});
      let response;
      try {response=await fetch(`/api/download/${encodeURIComponent(track.id)}?${params}`,{signal:AbortSignal.timeout(300000)});}
      catch(error) {throw new Error(error.name==='TimeoutError'?'Preparing the MP3 took too long. Try again.':'Can’t reach BHAAI Music. Is dev.py still running?');}
      if(!response.ok) {
        const data=await response.json().catch(()=>({}));
        throw new Error(data.error||'Download failed. Try again.');
      }
      const encoded=/filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition')||'');
      let name=`${track.artist} - ${track.title}.mp3`;
      try {if(encoded) name=decodeURIComponent(encoded[1]);} catch {}
      const blob=await response.blob();
      const link=Object.assign(document.createElement('a'),{href:URL.createObjectURL(blob),download:name});
      document.body.append(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(link.href),60000);
      return name;
    },
    // A plain form post into a hidden frame, so the browser streams the ZIP straight to disk (no memory limit).
    // The frame only loads a page when the server answers with an error instead of a file.
    downloadPlaylistZip(playlist,onError=()=>{}) {
      let frame=document.getElementById('download-frame');
      if(!frame) {
        frame=Object.assign(document.createElement('iframe'),{name:'download-frame',id:'download-frame',hidden:true,title:'Downloads'});
        document.body.append(frame);
      }
      frame.onload=()=>{
        try {const message=frame.contentDocument?.getElementById('error')?.textContent;if(message)onError(message);} catch {}
      };
      const tracks=playlist.tracks.map(t=>({id:t.id,title:t.title,artist:t.artist,album:t.album||'',art:t.art||''}));
      const form=Object.assign(document.createElement('form'),{method:'POST',action:'/api/download-playlist',target:'download-frame',hidden:true});
      form.append(Object.assign(document.createElement('input'),{type:'hidden',name:'playlist',value:JSON.stringify({title:playlist.title,tracks})}));
      document.body.append(form);form.submit();form.remove();
    },
    playlists:{
      all:async()=>((await run('playlists','readonly',s=>s.getAll()))||[]).sort((a,b)=>b.addedAt-a.addedAt),
      put:playlist=>run('playlists','readwrite',s=>s.put(playlist)),
      remove:id=>run('playlists','readwrite',s=>s.delete(id)),
    },
  };
})();
