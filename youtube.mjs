import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const venv=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const executable=process.env.BHAAI_PYTHON || process.env.SVARA_PYTHON || (existsSync(venv)?venv:process.platform==='win32'?'py':'python3');
const prefix=process.platform==='win32' && executable==='py'?['-3']:[];
const limits={status:{timeout:18000,length:0},search:{timeout:25000,length:200},playlist:{timeout:180000,length:500},stream:{timeout:35000,length:11},tag:{timeout:30000,length:4000}};
const pending=new Map();
let worker=null,nextId=0;

// One long-lived Python process keeps ytmusicapi and yt-dlp loaded between requests.
function startWorker() {
  const child=spawn(executable,[...prefix,path.join(root,'youtube_bridge.py'),'--serve'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','ignore'],env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1'}});
  const fail=error=>{
    if(worker===child) worker=null;
    for(const [id,job] of pending) {
      if(job.child!==child) continue;
      clearTimeout(job.timer);pending.delete(id);
      job.reject(Object.assign(new Error(error?.code==='ENOENT'?'Python was not found. Install Python 3.10 or newer, then run Setup-Windows.bat.':'The music helper stopped. Run Setup-Windows.bat if this keeps happening.'),{status:428}));
    }
  };
  child.on('error',fail);
  child.on('exit',()=>fail());
  child.stdin.on('error',()=>{});
  createInterface({input:child.stdout}).on('line',line=>{
    let data;try{data=JSON.parse(line);}catch{return;}
    const job=pending.get(data._id);if(!job)return;
    clearTimeout(job.timer);pending.delete(data._id);delete data._id;
    if(data.error) job.reject(Object.assign(new Error(data.error),{status:data.status||502}));
    else job.resolve(data);
  });
  child.unref();child.stdout.unref?.();child.stdin.unref?.();
  return child;
}

export function runYouTube(action,query='') {
  const limit=limits[action];
  if(!limit||typeof query!=='string'||query.length>limit.length) return Promise.reject(Object.assign(new Error('Invalid music request.'),{status:400}));
  if(pending.size>=24) return Promise.reject(Object.assign(new Error('BHAAI Music is busy. Wait a moment and try again.'),{status:429}));
  if(!worker) worker=startWorker();
  const child=worker,id=++nextId;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(new Error('The music service took too long. Please try again.'),{status:504}));},limit.timeout);
    pending.set(id,{resolve,reject,timer,child});
    child.stdin.write(JSON.stringify({_id:id,action,query})+'\n');
  });
}
