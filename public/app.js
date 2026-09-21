const $=id=>document.getElementById(id);
const lib=window.BhaaiLibrary;
const audio=$('audio');
const SHELVES=[
  {title:'Telugu chartbusters',query:'telugu hit songs'},
  {title:'Bollywood right now',query:'latest bollywood songs'},
  {title:'Tamil favourites',query:'tamil hit songs'},
  {title:'Global pop',query:'top pop hits'},
];
const SUGGESTIONS=['A. R. Rahman','Anirudh Ravichander','Sid Sriram','Arijit Singh','Shreya Ghoshal','The Weeknd'];

const valid=t=>t&&t.provider==='youtube'&&/^[A-Za-z0-9_-]{11}$/.test(t.id);
const load=(key,fallback)=>{try{const value=JSON.parse(localStorage.getItem(key)||'null');return Array.isArray(value)?value:fallback;}catch{return fallback;}};
const save=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
const slim=t=>({id:t.id,provider:'youtube',title:t.title,artist:t.artist,album:t.album||'',duration:t.duration||0,art:t.art||'',thumb:t.thumb||''});

const state={
  view:'home',query:'',results:[],searching:false,searchError:'',
  shelves:null,shelvesError:'',libraryTab:'playlists',
  playlists:[],playlist:null,
  favorites:load('svara-favorites',[]).filter(valid),history:load('svara-history',[]).filter(valid),
  queue:[],original:[],index:-1,context:'',shuffle:false,repeat:'off',
};

/* ---------- small helpers ---------- */
function h(tag,attrs={},...children) {
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attrs)) {
    if(value==null||value===false) continue;
    if(key==='class') node.className=value;
    else if(key==='text') node.textContent=value;
    else if(key.startsWith('on')) node.addEventListener(key.slice(2),value);
    else node.setAttribute(key,value===true?'':value);
  }
  for(const child of children.flat()) if(child!=null&&child!==false) node.append(child);
  return node;
}
function icon(name,fill=false) {
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('class','i'+(fill?' fill':''));svg.setAttribute('aria-hidden','true');
  const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#i-'+name);
  svg.append(use);return svg;
}
const time=s=>{s=Number(s);if(!Number.isFinite(s)||s<0)return '0:00';s=Math.floor(s);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
const longTime=s=>{const m=Math.round(s/60);return m<60?m+' min':Math.floor(m/60)+' hr '+(m%60)+' min';};
const songs=n=>n+(n===1?' song':' songs');
const sized=(url,size)=>typeof url==='string'&&url.startsWith('https://')?url.replace(/=w\d+-h\d+/,`=w${size}-h${size}`):'';
const artSrc=(track,size)=>sized(size>300?track.art:(track.thumb||track.art),size);
const shuffled=list=>{const copy=[...list];for(let i=copy.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[copy[i],copy[j]]=[copy[j],copy[i]];}return copy;};
const current=()=>state.queue[state.index]||null;
const loved=t=>state.favorites.some(f=>f.id===t.id);

let toastTimer;
function toast(text,ms=3400) {
  const box=$('toast');box.textContent=text;box.hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>{box.hidden=true;},ms);
}
function placeholder(title) {return h('div',{class:'ph',text:(String(title||'').trim().charAt(0)||'♪').toUpperCase()});}
function cover(item,size) {
  const src=artSrc(item,size);
  if(!src) return placeholder(item.title);
  const img=h('img',{src,alt:'',loading:'lazy',decoding:'async',referrerpolicy:'no-referrer'});
  img.addEventListener('error',()=>img.replaceWith(placeholder(item.title)),{once:true});
  return img;
}

/* ---------- navigation ---------- */
function go(view,{push=true,focus=false}={}) {
  state.view=view;
  for(const name of ['home','search','playlist','library']) $('view-'+name).hidden=name!==view;
  document.querySelectorAll('[data-go]').forEach(b=>b.classList.toggle('active',b.dataset.go===view||(view==='playlist'&&b.dataset.go==='library')));
  if(push) history.pushState({view,playlist:state.playlist?.id||null,query:state.query},'');
  window.scrollTo({top:0});
  renderView();renderRail();
  if(focus&&view==='search') $('query').focus();
}
window.addEventListener('popstate',event=>{
  const saved=event.state||{view:'home'};
  if(saved.view==='playlist') {
    const playlist=state.playlists.find(p=>p.id===saved.playlist);
    if(!playlist) {go('library',{push:false});return;}
    state.playlist=playlist;
  }
  if(saved.view==='search'&&saved.query!==state.query) {$('query').value=saved.query||'';runSearch(saved.query||'',{push:false});return;}
  go(saved.view,{push:false});
});
function renderView() {
  ({home:renderHome,search:renderSearch,playlist:renderPlaylist,library:renderLibrary})[state.view]();
}

/* ---------- track rows & shared controls ---------- */
function loveButton(track,extraClass='') {
  const button=h('button',{class:'icon-btn '+extraClass,'data-love':track.id,type:'button'},icon('heart'));
  paintLove(button);
  button.addEventListener('click',event=>{event.stopPropagation();toggleLove(track);});
  return button;
}
function paintLove(button) {
  const on=state.favorites.some(f=>f.id===button.dataset.love);
  button.setAttribute('aria-pressed',String(on));
  button.setAttribute('aria-label',on?'Remove from loved songs':'Love this song');
}
function toggleLove(track) {
  if(!track) return;
  const on=loved(track);
  state.favorites=on?state.favorites.filter(f=>f.id!==track.id):[slim(track),...state.favorites];
  save('svara-favorites',state.favorites);
  document.querySelectorAll(`[data-love="${track.id}"]`).forEach(paintLove);
  toast(on?'Removed from loved songs':'Added to loved songs');
  if(state.view==='library'&&state.libraryTab==='favorites') renderLibrary();
}

/* ---------- MP3 downloads (saved by the browser, usually to Downloads) ---------- */
const downloads=new Map(); // song id -> 'working' | 'done' (this visit only; the files live on the device)
function downloadButton(track,extraClass='') {
  const button=h('button',{class:'icon-btn '+extraClass,'data-dl':track.id,type:'button'});
  paintDownload(button);
  button.addEventListener('click',event=>{event.stopPropagation();downloadMP3(track);});
  return button;
}
function paintDownload(button) {
  const status=downloads.get(button.dataset.dl);
  button.classList.toggle('done',status==='done');
  button.replaceChildren(status==='working'?h('span',{class:'dl-spin','aria-hidden':'true'}):icon(status==='done'?'check':'download'));
  const label=status==='working'?'Preparing MP3…':status==='done'?'Saved as MP3 (download again)':'Download MP3';
  button.setAttribute('aria-label',label);button.title=label;
}
const refreshDownload=id=>document.querySelectorAll(`[data-dl="${id}"]`).forEach(paintDownload);
async function downloadMP3(track,{quiet=false}={}) {
  if(downloads.get(track.id)==='working') return true;
  downloads.set(track.id,'working');refreshDownload(track.id);
  if(!quiet) toast(`Preparing “${track.title}” as MP3…`);
  let ok=true;
  try {
    const name=await lib.downloadMP3(slim(track));
    downloads.set(track.id,'done');
    if(!quiet) toast(`Saved “${name}”`);
  } catch(error) {
    downloads.delete(track.id);ok=false;
    if(!quiet) toast(error.message,5000);
  }
  refreshDownload(track.id);
  return ok;
}
// Download all: one ZIP of MP3s. It appears in the browser's downloads at once and grows as each song is converted.
let downloadAllCooldown=0;
function downloadAll(playlist) {
  if(!playlist.tracks.length||Date.now()<downloadAllCooldown) return;
  downloadAllCooldown=Date.now()+4000;paintDownloadAll();setTimeout(paintDownloadAll,4100);
  lib.downloadPlaylistZip(playlist,message=>toast(message,6000));
  const minutes=Math.max(1,Math.round(playlist.tracks.length*4/60));
  toast(`Downloading “${playlist.title}” as a ZIP of ${songs(playlist.tracks.length)}. Watch your browser’s downloads: it grows as songs are converted (about ${minutes} min).`,8000);
}
function paintDownloadAll() {
  const p=state.playlist;if(!p)return;
  $('playlist-download').disabled=!p.tracks.length||Date.now()<downloadAllCooldown;
}

function trackList(tracks,{context='',playlist=null}={}) {
  const list=h('div',{class:'tracks',role:'list'});
  tracks.forEach((track,i)=>{
    const play=()=>playCollection(tracks,i,context);
    const actions=h('div',{class:'t-actions'},loveButton(track),downloadButton(track),
      h('button',{class:'icon-btn',type:'button','aria-label':'More options: '+track.title,'aria-haspopup':'menu',
        onclick:event=>{event.stopPropagation();openTrackMenu(event.currentTarget,track,playlist);}},icon('more',true)));
    list.append(h('div',{class:'track'+(current()?.id===track.id?' current':''),role:'listitem',tabindex:'0','data-track':track.id,'aria-label':`Play ${track.title} by ${track.artist}`,
      onclick:play,onkeydown:event=>{if(event.key==='Enter'&&event.target===event.currentTarget)play();}},
      h('div',{class:'num'},h('span',{text:String(i+1)}),icon('play',true)),
      h('div',{class:'thumb'},cover(track,240)),
      h('div',{class:'t-main'},h('span',{class:'t-title',text:track.title}),h('span',{class:'t-artist',text:track.artist})),
      h('span',{class:'t-album',text:track.album||''}),
      actions,
      h('span',{class:'t-time',text:time(track.duration)})));
  });
  return list;
}
function loadingRows(label) {
  return h('div',{class:'tracks loading-rows','aria-busy':'true','aria-label':label},Array.from({length:8},()=>h('div',{class:'track'},h('div'),h('div',{class:'thumb'}),h('div',{class:'t-main'},h('div',{class:'bar',style:'width:60%'})),h('div'),h('div'),h('div'))));
}
function markCurrentRows() {
  const id=current()?.id;
  document.querySelectorAll('.track[data-track]').forEach(row=>row.classList.toggle('current',row.dataset.track===id));
}
function empty(title,text,...extra) {return h('div',{class:'empty'},h('strong',{text:title}),h('p',{text}),...extra);}
function card({title,sub,item,onclick,label,media}) {
  return h('button',{class:'card',type:'button',onclick,'aria-label':label||title},
    h('div',{class:'card-art'},media||cover(item,480),h('span',{class:'play-badge','aria-hidden':'true'},icon('play',true))),
    h('span',{class:'card-title',text:title}),
    sub?h('span',{class:'card-sub',text:sub}):null);
}

/* ---------- home ---------- */
async function loadShelves() {
  state.shelves=null;state.shelvesError='';if(state.view==='home')renderHome();
  const results=await Promise.allSettled(SHELVES.map(s=>lib.search(s.query)));
  state.shelves=SHELVES.map((s,i)=>({...s,tracks:results[i].status==='fulfilled'?results[i].value.tracks.slice(0,20):[]})).filter(s=>s.tracks.length);
  if(!state.shelves.length) state.shelvesError=results.find(r=>r.status==='rejected')?.reason?.message||'Couldn’t load music right now.';
  fillWall();
  if(state.view==='home') renderHome();
}
function shelf(title,tracks,{context=title,more}={}) {
  return h('section',{class:'shelf'},
    h('div',{class:'shelf-head'},h('h3',{text:title}),more?h('button',{type:'button',onclick:more},'See all'):null),
    h('div',{class:'shelf-row'},tracks.map((t,i)=>card({title:t.title,sub:t.artist,item:t,label:`Play ${t.title} by ${t.artist}`,onclick:()=>playCollection(tracks,i,context)}))));
}
function renderHome() {
  const box=$('shelves');box.replaceChildren();
  if(state.history.length) box.append(shelf('Recently played',state.history.slice(0,20)));
  if(state.shelves===null) {
    for(const s of SHELVES.slice(0,2)) box.append(h('section',{class:'shelf'},h('div',{class:'shelf-head'},h('h3',{text:s.title})),
      h('div',{class:'shelf-row'},Array.from({length:7},()=>h('div',{class:'card skeleton','aria-hidden':'true'},h('div',{class:'card-art'}),h('span',{class:'card-title'}))))));
  } else if(state.shelvesError) {
    box.append(empty('Can’t reach the music service',state.shelvesError,h('button',{class:'btn',type:'button',onclick:loadShelves},'Try again')));
  } else for(const s of state.shelves) box.append(shelf(s.title,s.tracks,{more:()=>{$('query').value=s.query;runSearch(s.query);}}));
}
function fillWall() {
  const wall=$('wall');
  const tracks=[...new Map([...state.history,...(state.shelves||[]).flatMap(s=>s.tracks)].filter(t=>t.art).map(t=>[t.art,t])).values()];
  wall.replaceChildren();
  for(let c=0;c<3;c++) {
    const pick=tracks.length>=6?tracks.filter((_,i)=>i%3===c).slice(0,6):[];
    const tiles=pick.length?pick.map(t=>h('div',{class:'tile'},h('img',{src:artSrc(t,480),alt:'',decoding:'async',referrerpolicy:'no-referrer'}))):Array.from({length:5},()=>h('div',{class:'tile blank'}));
    // Tiles repeat twice so the drift animation loops without a seam.
    wall.append(h('div',{class:'wall-col'},tiles,tiles.map(t=>t.cloneNode(true))));
  }
}

/* ---------- search ---------- */
let searchSequence=0,typingTimer;
async function runSearch(query,{push=true}={}) {
  query=query.trim().slice(0,200);
  state.query=query;state.searchError='';state.results=[];state.searching=!!query;
  if(state.view!=='search') go('search',{push});
  else {if(push) history.replaceState({view:'search',query},'');renderSearch();}
  if(!query) return;
  const id=++searchSequence;
  try {
    const data=await lib.search(query);
    if(id!==searchSequence) return;
    state.results=data.tracks||[];
  } catch(error) {
    if(id!==searchSequence) return;
    state.searchError=error.message;
  }
  state.searching=false;
  if(state.view==='search') renderSearch();
}
function renderSearch() {
  const box=$('search-results');box.replaceChildren();
  $('search-label').textContent=state.query?'Results for':'Search';
  $('search-title').textContent=state.query?`“${state.query}”`:'Find something to play';
  if(!state.query) {
    box.append(empty('Search every song','Type a song, artist, or film name. Try one of these:'),
      h('div',{class:'tabs'},SUGGESTIONS.map(s=>h('button',{type:'button',onclick:()=>{$('query').value=s;runSearch(s);}},s))));
    return;
  }
  if(state.searching) {box.append(loadingRows('Searching'));return;}
  if(state.searchError) {box.append(empty('Search didn’t work',state.searchError,h('button',{class:'btn',type:'button',onclick:()=>runSearch(state.query)},'Try again')));return;}
  if(!state.results.length) {box.append(empty('No songs found','Check the spelling, or try the artist or film name instead.'));return;}
  box.append(trackList(state.results,{context:`Search: ${state.query}`}));
}

/* ---------- playlists (saved in this browser) ---------- */
const SOURCES={mine:'Your playlist',spotify:'Imported from Spotify',apple:'Imported from Apple Music',youtube:'Imported from YouTube Music'};
function openPlaylist(playlist,{push=true}={}) {state.playlist=playlist;go('playlist',{push});}
// A playlist without its own artwork shows its first song's cover, or a 2×2 grid once it has four different covers.
function playlistCover(p,size) {
  if(p.art) return cover({title:p.title,art:p.art},size);
  const arts=[...new Map(p.tracks.filter(t=>t.art).map(t=>[t.art,t])).values()];
  if(arts.length>=4) return h('div',{class:'mosaic'},arts.slice(0,4).map(t=>cover(t,size>300?600:240)));
  return arts.length?cover(arts[0],size):placeholder(p.title);
}
function renderPlaylist() {
  const p=state.playlist;if(!p){go('library',{push:false});return;}
  const total=p.tracks.reduce((sum,t)=>sum+(t.duration||0),0);
  $('playlist-cover').replaceChildren(playlistCover(p,1200));
  $('playlist-kind').textContent=SOURCES[p.source]||SOURCES.youtube;
  $('playlist-title').textContent=p.title;
  $('playlist-sub').textContent=[p.source==='mine'?'':p.author,songs(p.tracks.length),total?longTime(total):''].filter(Boolean).join(' · ');
  for(const id of ['playlist-play','playlist-shuffle']) $(id).disabled=!p.tracks.length;
  paintDownloadAll();
  $('playlist-tracks').replaceChildren(p.tracks.length?trackList(p.tracks,{context:p.title,playlist:p}):
    empty('This playlist is empty','Search for a song, tap ⋯ next to it, and choose this playlist.',h('button',{class:'btn',type:'button',onclick:()=>go('search',{focus:true})},icon('search'),'Find songs')));
}
async function savePlaylist(playlist) {
  playlist.updatedAt=Date.now();
  state.playlists=[playlist,...state.playlists.filter(p=>p.id!==playlist.id)].sort((a,b)=>b.addedAt-a.addedAt);
  try {await lib.playlists.put(playlist);} catch {toast('Couldn’t save that change. Your browser storage may be full or blocked.');}
  renderRail();
  if(state.view==='playlist'&&state.playlist?.id===playlist.id) renderPlaylist();
  if(state.view==='library'&&state.libraryTab==='playlists') renderLibrary();
}
let resolveName=null;
function askName({title,action,value=''}) {
  finishName(null);
  $('name-dialog-title').textContent=title;$('name-submit').textContent=action;
  $('playlist-name').value=value;
  closeMenu();$('name-dialog').showModal();$('playlist-name').select();
  return new Promise(resolve=>{resolveName=resolve;});
}
function finishName(name) {
  const resolve=resolveName;resolveName=null;
  if($('name-dialog').open) $('name-dialog').close();
  resolve?.(name);
}
function askConfirm({title,text,action}) {
  const dialog=$('confirm-dialog');
  $('confirm-title').textContent=title;$('confirm-text').textContent=text;$('confirm-ok').textContent=action;
  dialog.returnValue='';closeMenu();dialog.showModal();
  return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='ok'),{once:true}));
}
async function createPlaylist(firstTrack=null) {
  const name=await askName({title:'New playlist',action:'Create'});
  if(!name) return null;
  const id='mine-'+(crypto.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2));
  const playlist={id,source:'mine',title:name,author:'',art:'',tracks:firstTrack?[slim(firstTrack)]:[],addedAt:Date.now()};
  await savePlaylist(playlist);
  if(firstTrack) toast(`Created “${name}” and added “${firstTrack.title}”`);
  else {toast(`Created “${name}”`);openPlaylist(playlist);}
  return playlist;
}
async function renamePlaylist(playlist) {
  const name=await askName({title:'Rename playlist',action:'Save',value:playlist.title});
  if(!name||name===playlist.title) return;
  playlist.title=name;await savePlaylist(playlist);toast(`Renamed to “${name}”`);
}
async function addToPlaylist(playlist,track) {
  if(playlist.tracks.some(t=>t.id===track.id)) {toast(`“${track.title}” is already in “${playlist.title}”`);return;}
  playlist.tracks=[...playlist.tracks,slim(track)];
  await savePlaylist(playlist);toast(`Added to “${playlist.title}”`);
}
async function removeFromPlaylist(playlist,track) {
  playlist.tracks=playlist.tracks.filter(t=>t.id!==track.id);
  await savePlaylist(playlist);toast(`Removed “${track.title}” from “${playlist.title}”`);
}
async function removePlaylist(playlist) {
  const ok=await askConfirm({title:'Delete playlist?',action:'Delete',text:`“${playlist.title}” will be removed from this browser. This can’t be undone.`});
  if(!ok) return;
  try {await lib.playlists.remove(playlist.id);} catch {}
  state.playlists=state.playlists.filter(p=>p.id!==playlist.id);
  toast(`Deleted “${playlist.title}”`);
  state.libraryTab='playlists';go('library');
}

/* ---------- track menu ---------- */
let menuAnchor=null;
function openTrackMenu(anchor,track,inPlaylist=null) {
  if(menuAnchor===anchor) {closeMenu();return;}
  const menu=$('menu');menu.replaceChildren();
  const item=(label,iconName,onclick,extra='')=>h('button',{type:'button',role:'menuitem',class:extra,onclick:()=>{closeMenu();onclick();}},icon(iconName,iconName==='more'),h('span',{text:label}));
  menu.append(item(downloads.get(track.id)==='working'?'Preparing MP3…':'Download MP3','download',()=>downloadMP3(track)));
  if(inPlaylist) menu.append(item(`Remove from “${inPlaylist.title}”`,'trash',()=>removeFromPlaylist(inPlaylist,track),'danger'));
  menu.append(h('hr'));
  menu.append(h('p',{class:'menu-label'},'Add to playlist'),item('New playlist…','plus',()=>createPlaylist(track)));
  for(const p of state.playlists) {
    if(p.id===inPlaylist?.id) continue;
    const has=p.tracks.some(t=>t.id===track.id);
    const button=item(p.title,has?'check':'library',()=>addToPlaylist(p,track));
    if(has) {button.querySelector('.i').classList.add('check');button.setAttribute('aria-label',`${p.title} (already added)`);}
    menu.append(button);
  }
  menu.hidden=false;menuAnchor=anchor;anchor.setAttribute('aria-expanded','true');
  const rect=anchor.getBoundingClientRect(),box=menu.getBoundingClientRect();
  const left=Math.max(16,Math.min(rect.right-box.width,innerWidth-box.width-16));
  const top=rect.bottom+6+box.height>innerHeight-16?Math.max(16,rect.top-6-box.height):rect.bottom+6;
  menu.style.left=left+'px';menu.style.top=top+'px';
  menu.querySelector('button')?.focus();
}
function closeMenu() {
  if(!menuAnchor) return;
  $('menu').hidden=true;menuAnchor.setAttribute('aria-expanded','false');
  const anchor=menuAnchor;menuAnchor=null;
  if(document.activeElement===document.body||$('menu').contains(document.activeElement)) anchor.focus({preventScroll:true});
}
async function importPlaylist(form) {
  const input=form.querySelector('input'),button=form.querySelector('button'),status=form.nextElementSibling;
  const link=input.value.trim();if(!link)return;
  const external=/spotify|music\.apple\.com|itunes\.apple\.com/i.test(link);
  button.disabled=true;status.className='hint';
  status.textContent=external?'Finding these songs on YouTube Music… big playlists take up to a minute.':'Opening your playlist… big playlists can take a little while.';
  try {
    const data=await lib.readPlaylist(link);
    if(!data.tracks?.length) throw new Error(data.missingCount?'None of these songs could be found on YouTube Music.':'That playlist has no playable songs.');
    const playlist={id:data.id,source:data.source||'youtube',title:data.title,author:data.author||'',art:data.art||'',tracks:data.tracks.map(slim),addedAt:Date.now()};
    const existing=state.playlists.find(p=>p.id===playlist.id);
    if(existing) playlist.addedAt=existing.addedAt;
    await savePlaylist(playlist);
    input.value='';status.className='hint ok';
    status.textContent=[`${existing?'Updated':'Imported'} “${playlist.title}” — ${songs(playlist.tracks.length)}.`,
      data.missingCount?`${songs(data.missingCount)} couldn’t be found on YouTube Music.`:'',
      data.truncated?'Spotify only shares the first 100 songs of a playlist.':''].filter(Boolean).join(' ');
    openPlaylist(playlist);
  } catch(error) {status.className='hint error';status.textContent=error.message;}
  finally {button.disabled=false;}
}
function renderRail() {
  const list=$('rail-playlists');list.replaceChildren();
  if(!state.playlists.length) {list.append(h('li',{class:'rail-empty'},'Tap + to make a playlist, or paste a link on Home to import one.'));return;}
  for(const p of state.playlists) list.append(h('li',{},h('button',{type:'button',class:state.view==='playlist'&&state.playlist?.id===p.id?'active':'',onclick:()=>openPlaylist(p)},
    h('span',{class:'thumb'},playlistCover(p,240)),h('span',{text:p.title}))));
}

/* ---------- library ---------- */
function renderLibrary() {
  document.querySelectorAll('[data-tab]').forEach(tab=>tab.setAttribute('aria-selected',String(tab.dataset.tab===state.libraryTab)));
  const box=$('library-content');box.replaceChildren();
  if(state.libraryTab==='playlists') {
    const newCard=h('button',{class:'card new',type:'button',onclick:()=>createPlaylist()},h('div',{class:'card-art'},icon('plus')),h('span',{class:'card-title',text:'New playlist'}),h('span',{class:'card-sub',text:'Name it, then add songs'}));
    box.append(h('div',{class:'grid-cards'},newCard,state.playlists.map(p=>card({title:p.title,sub:`${songs(p.tracks.length)}${p.source==='mine'?'':' · '+(p.source==='spotify'?'Spotify':p.source==='apple'?'Apple Music':'YouTube Music')}`,
      media:playlistCover(p,480),label:`Open ${p.title}`,onclick:()=>openPlaylist(p)}))));
    if(!state.playlists.length) box.append(h('p',{class:'list-note',text:'Make your own playlist, or paste a Spotify, Apple Music, or YouTube Music link above to import one.'}));
  } else {
    if(!state.favorites.length) box.append(empty('No loved songs yet','Tap the heart on any song to keep it here.'));
    else box.append(h('p',{class:'list-note',text:songs(state.favorites.length)}),trackList(state.favorites,{context:'Loved songs'}));
  }
}

/* ---------- player ---------- */
let loadSequence=0,errorStreak=0,dragging=false;
const warmed=new Set();
function playCollection(tracks,start,context='') {
  if(current()?.id===tracks[start]?.id&&state.queue.length===tracks.length&&state.context===context) {togglePlay();return;}
  state.original=[...tracks];state.context=context;
  if(state.shuffle) {state.queue=[tracks[start],...shuffled(tracks.filter((_,i)=>i!==start))];start=0;}
  else state.queue=[...tracks];
  playAt(start);
}
function playAt(index) {
  const track=state.queue[index];if(!track)return;
  state.index=index;const sequence=++loadSequence;
  // The server finds the song's audio-only track and streams it; the page only shows the poster.
  audio.src='/api/stream/'+track.id;
  document.body.classList.add('buffering');
  setScrub(0,track.duration||0);
  showTrack(track);addHistory(track);markCurrentRows();
  audio.play().catch(error=>{
    if(sequence===loadSequence&&error.name==='NotAllowedError') {document.body.classList.remove('buffering');toast('Press play to start listening.');}
  });
}
function togglePlay() {
  if(!current()) {const first=state.shelves?.[0]?.tracks;if(first)playCollection(first,0,state.shelves[0].title);return;}
  if(audio.paused) audio.play().catch(()=>{});else audio.pause();
}
function next(auto=false) {
  if(!state.queue.length) return;
  if(auto&&state.repeat==='one') {audio.currentTime=0;audio.play().catch(()=>{});return;}
  let index=state.index+1;
  if(index>=state.queue.length) {
    if(state.repeat!=='all') {if(auto){audio.currentTime=0;toast('That’s the end of the list.');}return;}
    index=0;
  }
  playAt(index);
}
function previous() {
  if(audio.currentTime>3||state.index<=0) {audio.currentTime=0;return;}
  playAt(state.index-1);
}
function addHistory(track) {
  state.history=[slim(track),...state.history.filter(t=>t.id!==track.id)].slice(0,30);
  save('svara-history',state.history);
}
function setScrub(position,duration) {
  for(const input of document.querySelectorAll('[data-seek]')) {
    input.max=duration||0;
    if(!dragging) input.value=position;
    input.style.setProperty('--fill',duration?(Math.min(position,duration)/duration*100)+'%':'0%');
    input.disabled=!duration;
  }
  document.querySelectorAll('[data-elapsed]').forEach(n=>{n.textContent=time(position);});
  document.querySelectorAll('[data-duration]').forEach(n=>{n.textContent=time(duration);});
}
function showTrack(track) {
  $('open-now').disabled=false;
  $('mini-art').replaceChildren(cover(track,240));
  $('mini-title').textContent=track.title;$('mini-artist').textContent=track.artist;
  $('now-art').replaceChildren(cover(track,1200));
  $('now-title').textContent=track.title;
  $('now-artist').textContent=[track.artist,track.album].filter(Boolean).join(' — ');
  $('now-context').textContent=state.context?`Playing from ${state.context}`:'Now playing';
  const backdrop=$('now-backdrop');backdrop.replaceChildren();
  const big=cover(track,1200);if(big.tagName==='IMG')backdrop.append(big);
  for(const id of ['mini-love','now-love']) {$(id).dataset.love=track.id;paintLove($(id));}
  for(const id of ['mini-download','now-download']) {$(id).dataset.dl=track.id;paintDownload($(id));}
  document.title=`${track.title} · ${track.artist}`;
  extractTint(artSrc(track,240));
  renderUpNext();
  if('mediaSession' in navigator) {
    try {navigator.mediaSession.metadata=new MediaMetadata({title:track.title,artist:track.artist,album:track.album||'',artwork:track.art?[{src:artSrc(track,512),sizes:'512x512',type:'image/jpeg'}]:[]});} catch {}
  }
}
// Reading pixels needs CORS on the artwork. Hosts that don't send it just keep the default tint.
function extractTint(src) {
  if(!src) return;
  const img=new Image();
  img.crossOrigin='anonymous';
  img.onload=()=>{
    try {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=24;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,24,24);
      const data=ctx.getImageData(0,0,24,24).data;let r=0,g=0,b=0,weight=0;
      for(let i=0;i<data.length;i+=4) {
        const max=Math.max(data[i],data[i+1],data[i+2]),min=Math.min(data[i],data[i+1],data[i+2]);
        const w=.04+((max-min)/(max||1))**2*(max/255);
        r+=data[i]*w;g+=data[i+1]*w;b+=data[i+2]*w;weight+=w;
      }
      const scale=Math.min(1.8,190/(Math.max(r,g,b)/weight||1));
      document.documentElement.style.setProperty('--tint',[r,g,b].map(v=>Math.round(Math.min(255,v/weight*scale))).join(' '));
    } catch {}
  };
  img.src=src;
}
function renderUpNext() {
  const list=$('upnext-list');list.replaceChildren();
  const upcoming=state.queue.slice(state.index+1,state.index+51);
  if(!upcoming.length) {list.append(h('li',{class:'empty-note'},state.repeat==='all'&&state.queue.length>1?'The list starts again after this song.':'Nothing else queued.'));return;}
  upcoming.forEach((track,offset)=>list.append(h('li',{},h('button',{type:'button',onclick:()=>playAt(state.index+1+offset),'aria-label':`Play ${track.title} by ${track.artist}`},
    h('span',{class:'thumb'},cover(track,240)),h('span',{class:'up-text'},h('strong',{text:track.title}),h('span',{text:track.artist}))))));
}
function paintPlayState() {
  const playing=!audio.paused;
  document.body.classList.toggle('playing',playing);
  document.querySelectorAll('[data-action="toggle"]').forEach(button=>{
    button.replaceChildren(icon(playing?'pause':'play',true));
    button.setAttribute('aria-label',playing?'Pause':'Play');
  });
  if('mediaSession' in navigator) navigator.mediaSession.playbackState=playing?'playing':'paused';
}
function toggleShuffle() {
  state.shuffle=!state.shuffle;
  $('shuffle').setAttribute('aria-pressed',String(state.shuffle));
  const track=current();
  if(track) {
    if(state.shuffle) {state.original=[...state.queue];state.queue=[track,...shuffled(state.queue.filter((_,i)=>i!==state.index))];state.index=0;}
    else {state.queue=[...state.original];state.index=Math.max(0,state.queue.findIndex(t=>t.id===track.id));}
    renderUpNext();
  }
  toast(state.shuffle?'Shuffle on':'Shuffle off',1600);
}
function cycleRepeat() {
  state.repeat={off:'all',all:'one',one:'off'}[state.repeat];
  const button=$('repeat');
  button.classList.toggle('on',state.repeat!=='off');
  button.setAttribute('aria-label','Repeat: '+{off:'off',all:'all songs',one:'this song'}[state.repeat]);
  $('repeat-one').hidden=state.repeat!=='one';
  renderUpNext();
}
function openNow() {
  if(!current()) return;
  $('now').hidden=false;document.body.style.overflow='hidden';$('close-now').focus();
}
function closeNow() {
  $('now').hidden=true;document.body.style.overflow='';$('open-now').focus();
}
audio.addEventListener('play',paintPlayState);
audio.addEventListener('pause',paintPlayState);
audio.addEventListener('waiting',()=>document.body.classList.add('buffering'));
audio.addEventListener('playing',()=>{
  document.body.classList.remove('buffering');errorStreak=0;
  // Look up the next song's audio in the background so skipping feels instant.
  const upcoming=state.queue[state.index+1];
  if(upcoming&&!warmed.has(upcoming.id)) {
    warmed.add(upcoming.id);
    fetch('/api/stream/'+upcoming.id,{headers:{Range:'bytes=0-1'}}).then(r=>r.body?.cancel()).catch(()=>{});
  }
});
audio.addEventListener('timeupdate',()=>{
  const duration=Number.isFinite(audio.duration)?audio.duration:current()?.duration||0;
  setScrub(audio.currentTime,duration);
});
audio.addEventListener('durationchange',()=>{if(Number.isFinite(audio.duration))setScrub(audio.currentTime,audio.duration);});
audio.addEventListener('ended',()=>next(true));
audio.addEventListener('error',()=>{
  const track=current();if(!track||!audio.getAttribute('src'))return;
  document.body.classList.remove('buffering');
  errorStreak++;
  if(errorStreak<3&&state.index<state.queue.length-1) {toast(`Couldn’t play “${track.title}”. Skipping to the next song.`);setTimeout(()=>next(),1200);}
  else toast(navigator.onLine?`Couldn’t play “${track.title}”. Try another song.`:'You’re offline. Connect to the internet to keep listening.');
});

/* ---------- wiring ---------- */
document.querySelectorAll('[data-go]').forEach(button=>button.addEventListener('click',()=>go(button.dataset.go,{focus:true})));
document.querySelectorAll('[data-action="toggle"]').forEach(b=>b.addEventListener('click',togglePlay));
document.querySelectorAll('[data-action="next"]').forEach(b=>b.addEventListener('click',()=>next()));
document.querySelectorAll('[data-action="prev"]').forEach(b=>b.addEventListener('click',previous));
document.querySelectorAll('[data-import]').forEach(form=>form.addEventListener('submit',event=>{event.preventDefault();importPlaylist(form);}));
document.querySelectorAll('[data-tab]').forEach(tab=>tab.addEventListener('click',()=>{state.libraryTab=tab.dataset.tab;renderLibrary();}));
document.querySelectorAll('[data-seek]').forEach(input=>{
  input.addEventListener('input',()=>{dragging=true;const max=Number(input.max)||0;input.style.setProperty('--fill',max?(input.value/max*100)+'%':'0%');document.querySelectorAll('[data-elapsed]').forEach(n=>{n.textContent=time(input.value);});});
  input.addEventListener('change',()=>{dragging=false;if(current())audio.currentTime=Number(input.value);});
});
$('search-form').addEventListener('submit',event=>{event.preventDefault();clearTimeout(typingTimer);$('query').blur();runSearch($('query').value);});
$('query').addEventListener('input',()=>{
  clearTimeout(typingTimer);
  const value=$('query').value.trim();
  if(value.length>=2) typingTimer=setTimeout(()=>runSearch(value,{push:state.view!=='search'}),650);
});
$('shuffle').addEventListener('click',toggleShuffle);
$('repeat').addEventListener('click',cycleRepeat);
$('mini-love').addEventListener('click',()=>toggleLove(current()));
$('now-love').addEventListener('click',()=>toggleLove(current()));
$('open-now').addEventListener('click',openNow);
$('close-now').addEventListener('click',closeNow);
$('toggle-queue').addEventListener('click',()=>{const on=$('now').classList.toggle('show-queue');$('toggle-queue').setAttribute('aria-pressed',String(on));});
$('playlist-play').addEventListener('click',()=>{const p=state.playlist;if(p?.tracks?.length){if(state.shuffle)toggleShuffle();playCollection(p.tracks,0,p.title);}});
$('playlist-shuffle').addEventListener('click',()=>{const p=state.playlist;if(!p?.tracks?.length)return;if(!state.shuffle)toggleShuffle();playCollection(p.tracks,Math.floor(Math.random()*p.tracks.length),p.title);});
$('playlist-remove').addEventListener('click',()=>{if(state.playlist)removePlaylist(state.playlist);});
$('playlist-rename').addEventListener('click',()=>{if(state.playlist)renamePlaylist(state.playlist);});
document.querySelectorAll('[data-new-playlist]').forEach(button=>button.addEventListener('click',()=>createPlaylist()));
$('name-form').addEventListener('submit',event=>{event.preventDefault();const name=$('playlist-name').value.trim().slice(0,150);if(name)finishName(name);});
$('name-cancel').addEventListener('click',()=>finishName(null));
$('name-dialog').addEventListener('cancel',event=>{event.preventDefault();finishName(null);});
$('name-dialog').addEventListener('close',()=>finishName(null));
for(const id of ['mini-download','now-download']) $(id).addEventListener('click',()=>{const t=current();if(t)downloadMP3(t);});
$('playlist-download').addEventListener('click',()=>{if(state.playlist)downloadAll(state.playlist);});
$('now-add').addEventListener('click',event=>{const t=current();if(t)openTrackMenu(event.currentTarget,t);});
document.addEventListener('pointerdown',event=>{if(menuAnchor&&!$('menu').contains(event.target)&&!menuAnchor.contains(event.target))closeMenu();});
window.addEventListener('resize',closeMenu);
document.addEventListener('scroll',event=>{if(!$('menu').contains(event.target))closeMenu();},{capture:true,passive:true});
$('menu').addEventListener('keydown',event=>{
  const items=[...$('menu').querySelectorAll('button')],index=items.indexOf(document.activeElement);
  if(event.key==='ArrowDown'||event.key==='ArrowUp') {event.preventDefault();items[(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}
  else if(event.key==='Tab') closeMenu();
});
const savedVolume=Number(localStorage.getItem('svara-volume'));
audio.volume=Number.isFinite(savedVolume)&&localStorage.getItem('svara-volume')!==null?Math.min(1,Math.max(0,savedVolume)):.85;
$('volume').value=audio.volume;$('volume').style.setProperty('--fill',audio.volume*100+'%');
$('volume').addEventListener('input',()=>{audio.volume=Number($('volume').value);$('volume').style.setProperty('--fill',audio.volume*100+'%');try{localStorage.setItem('svara-volume',String(audio.volume));}catch{}});
document.addEventListener('keydown',event=>{
  const typing=event.target.closest?.('input,textarea,select,[contenteditable]');
  if(event.key==='Escape'&&menuAnchor) {closeMenu();return;}
  if($('name-dialog').open||$('confirm-dialog').open) return;
  if(event.key==='Escape'&&!$('now').hidden) {closeNow();return;}
  if(typing) return;
  if(event.key===' '&&!event.target.closest('button,[role="listitem"]')) {event.preventDefault();togglePlay();}
  else if(event.key==='/') {event.preventDefault();$('query').focus();}
  else if(event.key==='ArrowRight'&&event.shiftKey) next();
  else if(event.key==='ArrowLeft'&&event.shiftKey) previous();
});
if('mediaSession' in navigator) {
  const handlers={play:()=>audio.play().catch(()=>{}),pause:()=>audio.pause(),nexttrack:()=>next(),previoustrack:previous,
    seekto:details=>{audio.currentTime=details.seekTime;},seekbackward:()=>{audio.currentTime=Math.max(0,audio.currentTime-10);},seekforward:()=>{audio.currentTime+=10;}};
  for(const [action,handler] of Object.entries(handlers)) {try{navigator.mediaSession.setActionHandler(action,handler);}catch{}}
}

history.replaceState({view:'home'},'');
go('home',{push:false});
fillWall();
loadShelves();
lib.playlists.all().then(playlists=>{state.playlists=playlists;renderRail();renderView();})
  .catch(()=>toast('Browser storage is unavailable, so your playlists won’t be kept.'));
