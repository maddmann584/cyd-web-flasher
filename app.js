// app.js — stable WebSerial client for your firmware protocol
// Commands: LIST, PLAY <name>, DEL <name>, GET <name>, UPLOAD2 <name> <bytes>
// IMPORTANT: runs EVERYTHING through a single serial queue (no overlap)

const connectBtn   = document.getElementById("connectBtn");
const reloadBtn    = document.getElementById("reloadBtn");
const statusEl     = document.getElementById("status");
const fileInput    = document.getElementById("fileInput");
const uploadBtn    = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const gridEl       = document.getElementById("grid");
const errorBox     = document.getElementById("errorBox");

let port=null, reader=null, writer=null;
let connected=false;

let rx = new Uint8Array(0);
const dec = new TextDecoder();
const enc = new TextEncoder();

const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));

function setStatus(msg, ok=false){
  statusEl.textContent = msg;
  statusEl.style.color = ok ? "#00ff88" : "#a5a5b4";
}
function setUpload(msg, kind="muted"){
  uploadStatus.textContent = msg;
  uploadStatus.style.color = kind==="good" ? "#00ff88" : kind==="bad" ? "#ff4d4d" : "#a5a5b4";
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

function concatBytes(a,b){
  const out = new Uint8Array(a.length + b.length);
  out.set(a,0); out.set(b,a.length);
  return out;
}

async function pump(timeoutMs=15000){
  const start = Date.now();
  while(true){
    if(Date.now()-start > timeoutMs) throw new Error("Timeout waiting for device");
    const {value, done} = await reader.read();
    if(done) throw new Error("Serial closed");
    if(value && value.length){
      rx = concatBytes(rx, value);
      return;
    }
  }
}

async function readLine(timeoutMs=15000){
  const start = Date.now();
  while(true){
    const nl = rx.indexOf(0x0A);
    if(nl >= 0){
      let lineBytes = rx.slice(0, nl);
      rx = rx.slice(nl + 1);
      if(lineBytes.length && lineBytes[lineBytes.length-1] === 0x0D){
        lineBytes = lineBytes.slice(0, -1);
      }
      return dec.decode(lineBytes).trim();
    }
    if(Date.now()-start > timeoutMs) throw new Error("Timeout waiting for line");
    await pump(timeoutMs);
  }
}

async function readBytesExact(n, timeoutMs=60000){
  const start = Date.now();
  while(rx.length < n){
    if(Date.now()-start > timeoutMs) throw new Error("Timeout waiting for bytes");
    await pump(timeoutMs);
  }
  const out = rx.slice(0, n);
  rx = rx.slice(n);
  return out;
}

async function writeText(s){
  await writer.write(enc.encode(s));
}

async function flushNoise(ms=160){
  // Clear rx + absorb any boot/HELLO spam for a short time window
  rx = new Uint8Array(0);
  const t0 = Date.now();
  while(Date.now()-t0 < ms){
    try{ await pump(25); } catch {}
    await sleep(6);
  }
  rx = new Uint8Array(0);
}

function isNoise(line){
  if(!line) return true;
  if(line === "HELLO") return true;
  if(line.startsWith("ets ") || line.startsWith("rst:") || line.startsWith("load:") ||
     line.startsWith("entry ") || line.startsWith("configsip:") || line.startsWith("mode:") ||
     line.includes("boot:") || line.includes("SPI_FAST_FLASH_BOOT")) return true;
  return false;
}

async function readUntil(matchFn, timeoutMs=7000){
  const t0 = Date.now();
  while(true){
    if(Date.now()-t0 > timeoutMs) throw new Error("Timed out waiting for response");
    const line = await readLine(2500);
    if(isNoise(line)) continue;
    if(line.startsWith("ERR ")) throw new Error(line);
    if(matchFn(line)) return line;
  }
}

// ---- SERIAL QUEUE (no overlap ever) ----
let serialBusy = Promise.resolve();
function withSerialLock(fn){
  const run = async()=> await fn();
  const p = serialBusy.then(run, run);
  serialBusy = p.catch(()=>{});
  return p;
}

// ---- Preview cache ----
const previewURLs = new Map();
function setThumb(thumbEl, name, blob){
  if(previewURLs.has(name)){
    try{ URL.revokeObjectURL(previewURLs.get(name)); }catch{}
  }
  const url = URL.createObjectURL(blob);
  previewURLs.set(name, url);
  thumbEl.innerHTML = `<img alt="${escapeAttr(name)}" src="${url}">`;
}

// ---- Firmware commands ----
async function cmdLIST(){
  await flushNoise(140);
  await writeText("LIST\n");
  await readUntil(l => l === "BEGIN", 8000);

  const map = new Map();
  while(true){
    const line = await readLine(15000);
    if(isNoise(line)) continue;
    if(line === "END") break;
    if(line.startsWith("FILE ")){
      const parts = line.split(" ");
      const name = parts[1];
      const size = parts[2] || "";
      if(name && !map.has(name)) map.set(name, {name, size});
    }
  }
  return Array.from(map.values());
}

async function cmdPLAY(name){
  await flushNoise(80);
  await writeText(`PLAY ${name}\n`);
  await readUntil(l => l === "OK", 6000);
}

async function cmdDEL(name){
  await flushNoise(80);
  await writeText(`DEL ${name}\n`);
  await readUntil(l => l === "OK", 9000);
}

async function cmdGET(name){
  await flushNoise(80);
  await writeText(`GET ${name}\n`);
  const header = await readUntil(l => l.startsWith("SIZE "), 9000);
  const n = parseInt(header.slice(5), 10);
  if(!Number.isFinite(n) || n <= 0) throw new Error("Bad SIZE: " + header);
  const bytes = await readBytesExact(n, 90000);
  return new Blob([bytes], {type:"image/gif"});
}

async function cmdUPLOAD2(filename, bytes){
  await flushNoise(160);
  await writeText(`UPLOAD2 ${filename} ${bytes.length}\n`);
  await readUntil(l => l === "READY", 15000);

  // smaller chunks = way more reliable on CYD + SD
  const CHUNK = 256;
  let sent = 0;

  while(sent < bytes.length){
    const len = Math.min(CHUNK, bytes.length - sent);
    await writeText(`C ${len}\n`);
    await sleep(12);                    // let firmware finish reading header line
    await writer.write(bytes.slice(sent, sent + len));
    sent += len;

    const ack = await readUntil(l => l.startsWith("ACK "), 20000);
    if(!ack.startsWith("ACK ")) throw new Error("Bad ACK: " + ack);

    setUpload(`Uploading… ${Math.floor((sent/bytes.length)*100)}%`);
    await sleep(6);
  }

  await readUntil(l => l === "OK", 25000);
}

// ---- UI render ----
let refreshToken = 0;

async function refreshList(){
  const token = ++refreshToken;
  clearError();
  gridEl.innerHTML = "";
  setUpload("Loading GIFs…");

  let files = [];
  try{
    // retry so it loads “every time”
    for(let i=0;i<3;i++){
      files = await withSerialLock(async()=> await cmdLIST());
      if(files) break;
      await sleep(200);
    }
  } catch(e){
    showError("LIST failed:\n" + (e?.message || String(e)));
    setUpload("List failed", "bad");
    return;
  }

  if(token !== refreshToken) return;

  if(!files.length){
    gridEl.innerHTML = `<div class="hint">No GIFs found in /gifs</div>`;
    setUpload("No GIFs found.");
    return;
  }

  const cards = new Map();

  for(const f of files){
    const item = document.createElement("div");
    item.className = "cardItem";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.innerHTML = `<div class="ph">Loading preview…</div>`;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `
      <div class="name" title="${escapeAttr(f.name)}">${escapeHtml(f.name)}</div>
      <div class="actions">
        <button class="btn play">Play</button>
        <button class="btn del">Delete</button>
      </div>
    `;

    meta.querySelector(".play").onclick = async ()=>{
      clearError();
      try{
        setUpload(`Playing: ${f.name}…`);
        await withSerialLock(async()=> await cmdPLAY(f.name));
        setUpload(`Playing: ${f.name}`, "good");
      } catch(e){
        showError("PLAY failed:\n" + (e?.message || String(e)));
        setUpload("Play failed", "bad");
      }
    };

    meta.querySelector(".del").onclick = async ()=>{
      if(!confirm(`Delete ${f.name}?`)) return;
      clearError();
      try{
        setUpload(`Deleting: ${f.name}…`);
        await withSerialLock(async()=> await cmdDEL(f.name));
        if(previewURLs.has(f.name)){
          try{ URL.revokeObjectURL(previewURLs.get(f.name)); }catch{}
          previewURLs.delete(f.name);
        }
        setUpload("Deleted ✅", "good");
        await refreshList();
      } catch(e){
        showError("DEL failed:\n" + (e?.message || String(e)));
        setUpload("Delete failed", "bad");
      }
    };

    item.appendChild(thumb);
    item.appendChild(meta);
    gridEl.appendChild(item);
    cards.set(f.name, {thumb});
  }

  setUpload(`Loaded ${files.length} GIF(s). Previews…`);

  // previews sequential (and safe)
  for(const f of files){
    if(token !== refreshToken) return;
    const c = cards.get(f.name);
    if(!c) continue;

    try{
      const blob = await withSerialLock(async()=> await cmdGET(f.name));
      if(token !== refreshToken) return;
      setThumb(c.thumb, f.name, blob);
    } catch(e){
      c.thumb.innerHTML = `<div class="ph">No preview</div>`;
    }
  }

  setUpload("Ready ✅", "good");
}

// ---- Upload flow ----
async function uploadFlow(){
  clearError();
  const file = fileInput.files?.[0];
  if(!file){ setUpload("Pick a GIF first", "bad"); return; }

  const safe = file.name.replace(/[^\w.\-]/g,"_");
  const bytes = new Uint8Array(await file.arrayBuffer());

  // cancel any preview loading
  refreshToken++;

  try{
    setUpload(`Uploading ${safe}…`);
    await withSerialLock(async()=> await cmdUPLOAD2(safe, bytes));
    setUpload("Upload complete ✅", "good");
    await refreshList();
  } catch(e){
    showError("UPLOAD failed:\n" + (e?.message || String(e)));
    setUpload("Upload failed", "bad");
  }
}

// ---- Connect ----
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
    rx = new Uint8Array(0);

    connected = true;
    setStatus("Connected ✅", true);
    updateUploadEnabled();

    setUpload("Loading GIFs from SD…");
    await sleep(300);           // let board finish boot spam
    await refreshList();
  } catch(e){
    connected=false;
    updateUploadEnabled();
    setStatus("Not connected");
    showError("Connect failed:\n" + (e?.message || String(e)));
  }
}

// ---- events ----
connectBtn.onclick = ()=>connect();
reloadBtn.onclick = ()=>refreshList();
uploadBtn.onclick = ()=>uploadFlow();
fileInput.onchange = ()=>updateUploadEnabled();

// init
setStatus("Not connected");
setUpload("Connect to load your GIFs");
updateUploadEnabled();
