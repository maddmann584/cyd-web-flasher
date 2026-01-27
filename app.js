// GIF Player — app.js (FULL WORKING)
// Matches your firmware: LIST / UPLOAD2 / PLAY / DEL / GET
// - No refresh button (auto refresh on connect + after upload + after flash done)
// - Drag overlay ONLY while dragging over card (never stuck)
// - Real GIF previews using GET (SIZE n + raw bytes)
// - No duplicates (dedupe + cancel stale renders)
// - Upload works (UPLOAD2 + chunk ACK)

const connectBtn   = document.getElementById("connectBtn");
const statusEl     = document.getElementById("status");
const fileInput    = document.getElementById("fileInput");
const uploadBtn    = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const gridEl       = document.getElementById("grid");
const errorBox     = document.getElementById("errorBox");
const dropOverlay  = document.getElementById("dropOverlay");
const card         = document.getElementById("card");
const flashBtn     = document.getElementById("flashBtn");

let port=null, reader=null, writer=null;

// Raw byte buffer for BOTH text lines and binary GET (previews)
let rx = new Uint8Array(0);
const dec = new TextDecoder();
const enc = new TextEncoder();

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

// ---------- UI ----------
function showError(msg){
  errorBox.textContent = msg;
  errorBox.classList.remove("hidden");
}
function clearError(){
  errorBox.classList.add("hidden");
  errorBox.textContent = "";
}
function setStatus(msg, ok=false){
  statusEl.textContent = msg;
  statusEl.style.color = ok ? "#00ff88" : "#a8a8b3";
}
function setUpload(msg, kind="muted"){
  uploadStatus.textContent = msg;
  uploadStatus.style.color = kind==="good" ? "#00ff88" : kind==="bad" ? "#ff4d4d" : "#a8a8b3";
}
function disableUpload(disabled){
  uploadBtn.disabled = disabled;
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(s){ return String(s).replace(/["<>]/g,"_"); }

// ---------- previews ----------
const previewURLs = new Map(); // name -> objectURL
function setThumb(thumbEl, name, blob){
  if(previewURLs.has(name)){
    try{ URL.revokeObjectURL(previewURLs.get(name)); }catch{}
  }
  const url = URL.createObjectURL(blob);
  previewURLs.set(name, url);
  thumbEl.innerHTML = `<img alt="${escapeAttr(name)}" src="${url}">`;
}

// ---------- Connect ----------
async function connect(){
  clearError();

  if(!("serial" in navigator)){
    showError("WebSerial not supported. Use Chrome or Edge.");
    return;
  }
  if(!(location.protocol === "https:" || location.hostname === "localhost")){
    showError("This site must be HTTPS (or localhost) for WebSerial to work.");
    return;
  }

  try{
    setStatus("Connecting…");
    port = await navigator.serial.requestPort(); // chooser pops here
    await port.open({ baudRate: 115200 });

    writer = port.writable.getWriter();
    reader = port.readable.getReader();
    rx = new Uint8Array(0);

    setStatus("Connected ✅", true);
    disableUpload(false);
    setUpload("Connected. Drop or choose a GIF, then Upload.");

    // optional HELLO line
    try { await readLine(800); } catch {}

    await refreshList(); // auto refresh
  } catch(e){
    setStatus("Not connected");
    showError("Connect failed: " + (e?.message || String(e)));
  }
}

// ---------- Firmware commands ----------
async function cmdLIST(){
  await writeText("LIST\n");

  const map = new Map(); // dedupe
  while(true){
    const line = await readLine(15000);
    if(line === "BEGIN") continue;
    if(line === "END") break;

    if(line.startsWith("FILE ")){
      const parts = line.split(" ");
      const name = parts[1];
      const size = parts[2] || "";
      if(!map.has(name)) map.set(name, {name, size});
    }
  }
  return Array.from(map.values());
}

async function cmdPLAY(name){
  await writeText(`PLAY ${name}\n`);
  const resp = await readLine(15000);
  if(resp !== "OK") throw new Error(resp);
}

async function cmdDEL(name){
  await writeText(`DEL ${name}\n`);
  const resp = await readLine(15000);
  if(resp !== "OK") throw new Error(resp);
}

async function cmdGET(name){
  await writeText(`GET ${name}\n`);
  const header = await readLine(15000);
  if(!header.startsWith("SIZE ")) throw new Error(header);

  const n = parseInt(header.slice(5), 10);
  if(!Number.isFinite(n) || n <= 0) throw new Error("Bad SIZE: " + header);

  const bytes = await readBytesExact(n, 60000);
  return new Blob([bytes], { type: "image/gif" });
}

// ---------- Grid + auto refresh control ----------
let refreshToken = 0;

async function refreshList(){
  const token = ++refreshToken;
  clearError();
  gridEl.innerHTML = "";
  setUpload("Loading GIFs…");

  let files;
  try{
    files = await cmdLIST();
  } catch(e){
    showError("LIST failed: " + (e?.message || String(e)));
    setUpload("List failed", "bad");
    return;
  }

  if(token !== refreshToken) return;

  if(!files.length){
    gridEl.innerHTML = `<div class="hint">No GIFs yet — upload one!</div>`;
    setUpload("No GIFs found.");
    return;
  }

  for(const f of files){
    const item = document.createElement("div");
    item.className = "cardItem";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.innerHTML = `<div class="ph">Loading…</div>`;

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
        await cmdPLAY(f.name);
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
        await cmdDEL(f.name);

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

    // Preview load (GET)
    (async ()=>{
      try{
        if(token !== refreshToken) return;

        if(previewURLs.has(f.name)){
          thumb.innerHTML = `<img alt="${escapeAttr(f.name)}" src="${previewURLs.get(f.name)}">`;
          return;
        }

        const blob = await cmdGET(f.name);
        if(token !== refreshToken) return;

        setThumb(thumb, f.name, blob);
      } catch{
        thumb.innerHTML = `<div class="ph">No preview</div>`;
      }
    })();
  }

  setUpload(`Loaded ${files.length} GIF(s).`);
}

// ---------- Upload ----------
async function uploadFlow(){
  clearError();
  const file = fileInput.files?.[0];
  if(!file){ setUpload("Pick a GIF first", "bad"); return; }
  if(!/\.gif$/i.test(file.name)){ setUpload("Choose a .gif file", "bad"); return; }

  const safeName = file.name.replace(/[^\w.\-]/g,"_");
  const bytes = new Uint8Array(await file.arrayBuffer());

  try{
    setUpload(`Sending header… (${bytes.length} bytes)`);
    await writeText(`UPLOAD2 ${safeName} ${bytes.length}\n`);

    const ready = await readLine(20000);
    if(ready !== "READY") throw new Error("Device refused: " + ready);

    await new Promise(r=>setTimeout(r, 20));

    const CHUNK = 1024;
    let sent = 0;

    while(sent < bytes.length){
      const len = Math.min(CHUNK, bytes.length - sent);
      await writeText(`C ${len}\n`);
      await writer.write(bytes.slice(sent, sent + len));
      sent += len;

      const ack = await readLine(20000);
      if(!ack.startsWith("ACK ")) throw new Error("Upload failed: " + ack);

      setUpload(`Uploading… ${Math.floor((sent/bytes.length)*100)}%`);
    }

    const done = await readLine(20000);
    if(done !== "OK") throw new Error("Upload failed: " + done);

    setUpload("Upload complete ✅", "good");
    await refreshList(); // auto refresh after upload
  } catch(e){
    showError(e?.message || String(e));
    setUpload("Upload failed", "bad");
  }
}

// ---------- Drag overlay (only while dragging over card) ----------
let dragDepth = 0;
function showDrop(){ dropOverlay.classList.remove("hidden"); }
function hideDrop(){ dropOverlay.classList.add("hidden"); dragDepth = 0; }
hideDrop(); // ensure hidden on load

card.addEventListener("dragenter", (e)=>{
  e.preventDefault();
  dragDepth++;
  showDrop();
});
card.addEventListener("dragover", (e)=>{
  e.preventDefault();
  showDrop();
});
card.addEventListener("dragleave", (e)=>{
  e.preventDefault();
  dragDepth--;
  if(dragDepth <= 0) hideDrop();
});
card.addEventListener("drop", (e)=>{
  e.preventDefault();
  hideDrop();

  const files = Array.from(e.dataTransfer?.files || []);
  const gif = files.find(f => /\.gif$/i.test(f.name));
  if(!gif){ setUpload("Drop a .gif file", "bad"); return; }

  const dt = new DataTransfer();
  dt.items.add(gif);
  fileInput.files = dt.files;

  setUpload(`Dropped: ${gif.name} (ready). Click Upload.`, "muted");
});

// ---------- Auto refresh after flashing ----------
if(flashBtn){
  // ESP Web Tools fires "state-changed" events; when it says "done", refresh list if connected
  flashBtn.addEventListener("state-changed", async (ev)=>{
    const st = ev?.detail?.state || "";
    if(String(st).toLowerCase() === "done"){
      // give device a moment to reboot
      setUpload("Flashed. Reconnect, then it will load GIFs.", "muted");
      // if already connected, try refresh after reboot delay
      try{
        await new Promise(r=>setTimeout(r, 2500));
        if(writer && reader) await refreshList();
      } catch {}
    }
  });
}

// ---------- Buttons ----------
disableUpload(true);
setStatus("Not connected");
setUpload("Connect to start.");

connectBtn.onclick = async ()=>{ await connect(); };
uploadBtn.onclick  = async ()=>{ await uploadFlow(); };
