const connectBtn   = document.getElementById("connectBtn");
const statusEl     = document.getElementById("status");
const fileInput    = document.getElementById("fileInput");
const uploadBtn    = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const listEl       = document.getElementById("list");
const errorBox     = document.getElementById("errorBox");

let port=null, reader=null, writer=null;
let rxText = "";
const dec = new TextDecoder();
const enc = new TextEncoder();
let connected=false;

const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));

function setStatus(msg, ok=false){
  statusEl.textContent = msg;
  statusEl.style.color = ok ? "#00ff88" : "#a8a8b3";
}
function setUpload(msg, kind="muted"){
  uploadStatus.textContent = msg;
  uploadStatus.style.color = kind==="good" ? "#00ff88" : kind==="bad" ? "#ff4d4d" : "#a8a8b3";
}
function showError(msg){
  errorBox.textContent = msg;
  errorBox.classList.remove("hidden");
}
function clearError(){
  errorBox.textContent = "";
  errorBox.classList.add("hidden");
}
function updateUploadEnabled(){
  uploadBtn.disabled = !(connected && fileInput.files && fileInput.files[0]);
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(s){ return String(s).replace(/["<>]/g,"_"); }

async function pump(timeoutMs=15000){
  const start = Date.now();
  while(true){
    if(Date.now()-start > timeoutMs) throw new Error("Timeout waiting for device");
    const {value, done} = await reader.read();
    if(done) throw new Error("Serial closed");
    if(value){
      rxText += dec.decode(value, {stream:true});
      return;
    }
  }
}
async function readLine(timeoutMs=15000){
  const start = Date.now();
  while(true){
    const idx = rxText.indexOf("\n");
    if(idx >= 0){
      const line = rxText.slice(0, idx).replace("\r","").trim();
      rxText = rxText.slice(idx+1);
      return line;
    }
    if(Date.now()-start > timeoutMs) throw new Error("Timeout waiting for line");
    await pump(timeoutMs);
  }
}
async function writeText(s){
  await writer.write(enc.encode(s));
}
async function flushInput(ms=250){
  rxText = "";
  const t0 = Date.now();
  while(Date.now()-t0 < ms){
    try{ await pump(30); } catch {}
    await sleep(10);
  }
  rxText = "";
}
function isNoise(line){
  if(!line) return true;
  if(line === "HELLO") return true;
  if(line.startsWith("ets ") || line.startsWith("rst:") || line.startsWith("load:") ||
     line.startsWith("entry ") || line.startsWith("configsip:") || line.startsWith("mode:")) return true;
  return false;
}

// single queue so commands never overlap
let busy = Promise.resolve();
function locked(fn){
  const p = busy.then(fn, fn);
  busy = p.catch(()=>{});
  return p;
}

async function cmdLIST(){
  await flushInput(250);
  await writeText("LIST\n");

  // wait for BEGIN
  while(true){
    const l = await readLine(12000);
    if(isNoise(l)) continue;
    if(l === "BEGIN") break;
  }

  const map = new Map();
  while(true){
    const l = await readLine(15000);
    if(isNoise(l)) continue;
    if(l === "END") break;
    if(l.startsWith("FILE ")){
      const parts = l.split(" ");
      const name = parts[1];
      const size = parts[2] || "";
      if(name && !map.has(name)) map.set(name, {name, size});
    }
  }
  return Array.from(map.values());
}

async function cmdPLAY(name){
  await flushInput(120);
  await writeText(`PLAY ${name}\n`);
  while(true){
    const l = await readLine(9000);
    if(isNoise(l)) continue;
    if(l === "OK") return;
    if(l.startsWith("ERR")) throw new Error(l);
  }
}
async function cmdDEL(name){
  await flushInput(120);
  await writeText(`DEL ${name}\n`);
  while(true){
    const l = await readLine(15000);
    if(isNoise(l)) continue;
    if(l === "OK") return;
    if(l.startsWith("ERR")) throw new Error(l);
  }
}

async function cmdUPLOAD2(filename, bytes){
  await flushInput(250);
  await writeText(`UPLOAD2 ${filename} ${bytes.length}\n`);

  // wait READY
  while(true){
    const l = await readLine(20000);
    if(isNoise(l)) continue;
    if(l === "READY") break;
    if(l.startsWith("ERR")) throw new Error(l);
  }

  const CHUNK = 256;
  let sent = 0;

  while(sent < bytes.length){
    const len = Math.min(CHUNK, bytes.length - sent);
    await writeText(`C ${len}\n`);
    await sleep(12);
    await writer.write(bytes.slice(sent, sent + len));
    sent += len;

    // wait ACK
    while(true){
      const l = await readLine(20000);
      if(isNoise(l)) continue;
      if(l.startsWith("ACK ")) break;
      if(l.startsWith("ERR")) throw new Error(l);
    }

    setUpload(`Uploading… ${Math.floor((sent/bytes.length)*100)}%`);
    await sleep(6);
  }

  // wait OK
  while(true){
    const l = await readLine(25000);
    if(isNoise(l)) continue;
    if(l === "OK") return;
    if(l.startsWith("ERR")) throw new Error(l);
  }
}

async function refreshList(){
  clearError();
  listEl.innerHTML = "";
  setUpload("Loading GIFs…");

  try{
    const files = await locked(async()=> await cmdLIST());

    if(!files.length){
      listEl.innerHTML = `<div class="hint">No GIFs found in /gifs</div>`;
      setUpload("No GIFs found.");
      return;
    }

    for(const f of files){
      const row = document.createElement("div");
      row.className = "item";
      row.innerHTML = `
        <div>
          <div class="name" title="${escapeAttr(f.name)}">${escapeHtml(f.name)}</div>
          <div class="meta">${escapeHtml(f.size)} bytes</div>
        </div>
        <div class="actions">
          <button class="play">Play</button>
          <button class="del">Delete</button>
        </div>
      `;
      row.querySelector(".play").onclick = async ()=>{
        clearError();
        try{
          setUpload(`Playing ${f.name}…`);
          await locked(async()=> await cmdPLAY(f.name));
          setUpload(`Playing ${f.name} ✅`, "good");
        } catch(e){
          showError("PLAY failed:\n" + (e?.message || String(e)));
          setUpload("Play failed", "bad");
        }
      };
      row.querySelector(".del").onclick = async ()=>{
        if(!confirm(`Delete ${f.name}?`)) return;
        clearError();
        try{
          setUpload(`Deleting ${f.name}…`);
          await locked(async()=> await cmdDEL(f.name));
          setUpload("Deleted ✅", "good");
          await refreshList();
        } catch(e){
          showError("DEL failed:\n" + (e?.message || String(e)));
          setUpload("Delete failed", "bad");
        }
      };
      listEl.appendChild(row);
    }

    setUpload(`Loaded ${files.length} GIF(s) ✅`, "good");
  } catch(e){
    showError("LIST failed:\n" + (e?.message || String(e)));
    setUpload("List failed", "bad");
  }
}

async function connect(){
  clearError();
  if(!(location.protocol === "https:" || location.hostname === "localhost")){
    showError("WebSerial requires HTTPS (or localhost).");
    return;
  }
  if(!("serial" in navigator)){
    showError("WebSerial not supported. Use Chrome/Edge.");
    return;
  }

  try{
    setStatus("Choose device…");
    port = await navigator.serial.requestPort();
    setStatus("Opening @115200…");
    await port.open({baudRate:115200});

    writer = port.writable.getWriter();
    reader = port.readable.getReader();
    rxText = "";

    connected = true;
    setStatus("Connected ✅", true);
    updateUploadEnabled();

    setUpload("Waiting for device…");
    await sleep(900);        // IMPORTANT: ESP resets here often
    await refreshList();     // auto refresh after connect
  } catch(e){
    connected=false;
    updateUploadEnabled();
    setStatus("Not connected");
    showError("Connect failed:\n" + (e?.message || String(e)));
  }
}

connectBtn.onclick = ()=>connect();

uploadBtn.onclick = async ()=>{
  clearError();
  const file = fileInput.files?.[0];
  if(!file){ setUpload("Pick a GIF first", "bad"); return; }

  const safe = file.name.replace(/[^\w.\-]/g,"_");
  const bytes = new Uint8Array(await file.arrayBuffer());

  try{
    setUpload(`Uploading ${safe}…`);
    await locked(async()=> await cmdUPLOAD2(safe, bytes));
    setUpload("Upload complete ✅", "good");
    await refreshList(); // auto refresh after upload
  } catch(e){
    showError("UPLOAD failed:\n" + (e?.message || String(e)));
    setUpload("Upload failed", "bad");
  }
};

fileInput.onchange = ()=>updateUploadEnabled();

setStatus("Not connected");
setUpload("Connect to load your GIFs");
updateUploadEnabled();
