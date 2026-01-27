// GIF Player — app.js (HARD RESYNC + RELIABLE LIST/PLAY/DEL/UPLOAD + PREVIEWS)
// Works with your firmware: LIST / UPLOAD2 / PLAY / DEL / GET

const connectBtn   = document.getElementById("connectBtn");
const statusEl     = document.getElementById("status");
const fileInput    = document.getElementById("fileInput");
const uploadBtn    = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const gridEl       = document.getElementById("grid");
const errorBox     = document.getElementById("errorBox");

let port=null, reader=null, writer=null;
let connected = false;

// Shared RX buffer for text + binary
let rx = new Uint8Array(0);
const dec = new TextDecoder();
const enc = new TextEncoder();

const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));

// ---------- UI ----------
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
  errorBox.classList.add("hidden");
  errorBox.textContent = "";
}
function updateUploadEnabled(){
  uploadBtn.disabled = !(connected && fileInput.files && fileInput.files[0]);
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(s){ return String(s).replace(/["<>]/g,"_"); }

// ---------- Serial helpers ----------
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
    const nl = rx.indexOf(0x0A); // '\n'
    if(nl >= 0){
      let lineBytes = rx.slice(0, nl);
      rx = rx.slice(nl + 1);
      if(lineBytes.length && lineBytes[lineBytes.length-1] === 0x0D){
        lineBytes = lineBytes.slice(0, -1); // trim '\r'
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

// ---------- SERIAL QUEUE (no overlap) ----------
let serialBusy = Promise.resolve();
function withSerialLock(fn){
  const run = async () => await fn();
  const p = serialBusy.then(run, run);
  serialBusy = p.catch(()=>{});
  return p;
}

// ---------- Resync helpers ----------
async function flushInput(ms=150){
  // Drain any buffered bytes + any incoming noise for a short window
  rx = new Uint8Array(0);
  const t0 = Date.now();
  while(Date.now() - t0 < ms){
    // try a non-blocking-ish pump (short timeout)
    try { await pump(30); } catch { /* ignore */ }
    await sleep(5);
  }
  rx = new Uint8Array(0);
}

async function readUntil(matchFn, timeoutMs=6000){
  const t0 = Date.now();
  while(true){
    if(Date.now() - t0 > timeoutMs) throw new Error("Timed out waiting for expected response");
    const line = await readLine(2000);
    if(!line) continue;

    // ignore common noise
    if(line.startsWith("ets ") || line.startsWith("rst:") || line.startsWith("load:") ||
       line.startsWith("entry ") || line.startsWith("configsip:") || line.startsWith("mode:") ||
       line === "HELLO") {
      continue;
    }

    // allow firmware errors to surface
    if(line.startsWith("ERR ")) throw new Error(line);

    if(matchFn(line)) return line;
  }
}

// ---------- Preview cache ----------
const previewURLs = new Map();
function setThumb(thumbEl, name, blob){
  if(previewURLs.has(name)){
    try{ URL.revokeObjectURL(previewURLs.get(name)); }catch{}
  }
  const url = URL.createObjectURL(blob);
  previewURLs.set(name, url);
  thumbEl.innerHTML = `<img alt="${escapeAttr(name)}" src="${url}">`;
}

// ---------- Commands (call only inside withSerialLock) ----------
async function cmdLIST(){
  await flushInput(120);
  await writeText("LIST\n");

  // wait for BEGIN even if noise comes first
  await readUntil(line => line === "BEGIN", 6000);

  const map = new Map();
  while(true){
    const line = await readLine(15000);
    if(!line) continue;

    if(line === "END") break;
    if(line.startsWith("FILE ")){
      const parts = line.split(" ");
      const name = parts[1];
      const size = parts[2] || "";
      if(name && !map.has(name)) map.set(name, {name, size});
    }
    // ignore any other noise inside listing
  }
  return Array.from(map.values());
}

async function cmdPLAY(name){
  await flushInput(80);
  await writeText(`PLAY ${name}\n`);
  await readUntil(line => line === "OK", 4000);
}

async function cmdDEL(name){
  await flushInput(80);
  await writeText(`DEL ${name}\n`);
  await readUntil(line => line === "OK", 6000);
}

async function cmdGET(name){
  await flushInput(80);
  await writeText(`GET ${name}\n`);

  const header = await readUntil(line => line.startsWith("SIZE "), 6000);
  const n = parseInt(header.slice(5), 10);
  if(!Number.isFinite(n) || n <= 0) throw new Error("Bad SIZE: " + header);

  // Immediately read the binary payload
  const bytes = await readBytesExact(n, 60000);
  return new Blob([bytes], { type:"image/gif" });
}

// ---------- Render + previews ----------
let refreshToken = 0;

async function refreshList(){
  const token = ++refreshToken;
  clearError();
  gridEl.innerHTML = "";
  setUpload("Loading GIFs…");

  let files = [];
  // retry LIST to make it “every time”
  for(let attempt=1; attempt<=3; attempt++){
    try{
      files = await withSerialLock(async ()=> await cmdLIST());
      break;
    } catch(e){
      if(attempt === 3) throw e;
      await sleep(200);
    }
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
    thumb.innerHTML = `<div class="ph">Preview…</div>`;

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
        await withSerialLock(async ()=> await cmdPLAY(f.name));
        setUpload(`Playing: ${f.name}`, "good");
      } catch(e){
        showError("Play failed: " + (e?.message || String(e)));
        setUpload("Play failed", "bad");
      }
    };

    meta.querySelector(".del").onclick = async ()=>{
      if(!confirm(`Delete ${f.name}?`)) return;
      clearError();
      try{
        setUpload(`Deleting: ${f.name}…`);
        await withSerialLock(async ()=> await cmdDEL(f.name));

        if(previewURLs.has(f.name)){
          try{ URL.revokeObjectURL(previewURLs.get(f.name)); }catch{}
          previewURLs.delete(f.name);
        }

        setUpload("Deleted.", "good");
        await refreshList();
      } catch(e){
        showError("Delete failed: " + (e?.message || String(e)));
        setUpload("Delete failed", "bad");
      }
    };

    item.appendChild(thumb);
    item.appendChild(meta);
    gridEl.appendChild(item);
    cards.set(f.name, {thumb});
  }

  setUpload(`Loaded ${files.length} GIF(s). Loading previews…`);

  // previews: sequential + locked + resynced GET
  for(const f of files){
    if(token !== refreshToken) return;

    const c = cards.get(f.name);
    if(!c) continue;

    if(previewURLs.has(f.name)){
      c.thumb.innerHTML = `<img alt="${escapeAttr(f.name)}" src="${previewURLs.get(f.name)}">`;
      continue;
    }

    try{
      const blob = await withSerialLock(async ()=> await cmdGET(f.name));
      if(token !== refreshToken) return;
      setThumb(c.thumb, f.name, blob);
    } catch {
      c.thumb.innerHTML = `<div class="ph">No preview</div>`;
    }
  }

  setUpload("Ready ✅", "good");
}

// ---------- Upload (more tolerant timing) ----------
async function uploadFlow(){
  clearError();
  const file = fileInput.files?.[0];
  if(!file){ setUpload("Pick a GIF first", "bad"); return; }

  const safeName = file.name.replace(/[^\w.\-]/g,"_");
  const bytes = new Uint8Array(await file.arrayBuffer());

  refreshToken++; // cancel previews while uploading

  try{
    await withSerialLock(async ()=>{
      await flushInput(150);
      setUpload(`Starting upload… (${bytes.length} bytes)`);

      await writeText(`UPLOAD2 ${safeName} ${bytes.length}\n`);
      const ready = await readUntil(line => line === "READY", 12000);
      if(ready !== "READY") throw new Error("Device refused: " + ready);

      const CHUNK = 1024;
      let sent = 0;

      while(sent < bytes.length){
        const len = Math.min(CHUNK, bytes.length - sent);

        await writeText(`C ${len}\n`);
        await sleep(10); // let firmware finish reading line
        await writer.write(bytes.slice(sent, sent + len));
        sent += len;

        // wait for ACK (ignore noise)
        const ack = await readUntil(line => line.startsWith("ACK "), 20000);
        if(!ack.startsWith("ACK ")) throw new Error("Upload failed: " + ack);

        setUpload(`Uploading… ${Math.floor((sent/bytes.length)*100)}%`);
        await sleep(5);
      }

      await readUntil(line => line === "OK", 20000);
    });

    setUpload("Upload complete ✅", "good");
    await refreshList(); // refresh every time after upload
  } catch(e){
    showError(e?.message || String(e));
    setUpload("Upload failed", "bad");
  }
}

// ---------- Connect ----------
async function connect(){
  clearError();

  if(!(location.protocol === "https:" || location.hostname === "localhost")){
    showError("WebSerial requires HTTPS (or localhost). Use GitHub Pages or localhost.");
    return;
  }
  if(!("serial" in navigator)){
    showError("WebSerial not supported. Use Chrome or Edge.");
    return;
  }

  try{
    setStatus("Opening port chooser…");
    port = await navigator.serial.requestPort();
    setStatus("Opening @115200…");
    await port.open({ baudRate:115200 });

    writer = port.writable.getWriter();
    reader = port.readable.getReader();
    rx = new Uint8Array(0);

    connected = true;
    setStatus("Connected ✅", true);
    setUpload("Connected. Loading GIFs…");
    updateUploadEnabled();

    // Give the ESP a moment to finish printing HELLO/boot noise
    await sleep(250);
    await refreshList();
  } catch(e){
    connected = false;
    updateUploadEnabled();
    setStatus("Not connected");
    showError("Connect failed: " + (e?.message || String(e)));
  }
}

// ---------- Events ----------
connectBtn.onclick = async ()=> {
  try { await connect(); }
  catch(e){ showError(e?.message || String(e)); }
};
uploadBtn.onclick  = async ()=> {
  try { await uploadFlow(); }
  catch(e){ showError(e?.message || String(e)); }
};
fileInput.onchange = ()=> updateUploadEnabled();

// ---------- Init ----------
connected = false;
setStatus("Not connected");
setUpload("Connect to start.");
updateUploadEnabled();
