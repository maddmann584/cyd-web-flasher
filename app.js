const connectBtn = document.getElementById("connectBtn");
const statusEl   = document.getElementById("status");
const fileInput  = document.getElementById("fileInput");
const uploadBtn  = document.getElementById("uploadBtn");
const refreshBtn = document.getElementById("refreshBtn");
const uploadStatus = document.getElementById("uploadStatus");
const gridEl = document.getElementById("grid");
const errorBox = document.getElementById("errorBox");
const dropOverlay = document.getElementById("dropOverlay");
const card = document.getElementById("card");

let port=null, reader=null, writer=null;
const dec = new TextDecoder();
const enc = new TextEncoder();
let rxBuf = "";

// Your screen size (portrait)
const TARGET_W = 240;
const TARGET_H = 320;
const FIT_MODE = "contain"; // contain | cover | stretch

// Cache thumbnails for uploaded gifs (browser-side)
const THUMB_DB = "maddmann_gif_thumbs_v1";

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
  statusEl.style.color = ok ? "#00ff88" : "#a8a8b3"; // no orange
}
function setUpload(msg, kind="muted"){
  uploadStatus.textContent = msg;
  uploadStatus.style.color = kind==="good" ? "#00ff88" : kind==="bad" ? "#ff4d4d" : "#a8a8b3";
}
function disableUI(disabled){
  uploadBtn.disabled = disabled;
  refreshBtn.disabled = disabled;
}

async function readLine(timeoutMs=12000){
  const start = Date.now();
  while(true){
    const idx = rxBuf.indexOf("\n");
    if(idx >= 0){
      const line = rxBuf.slice(0, idx).replace("\r","").trim();
      rxBuf = rxBuf.slice(idx+1);
      return line;
    }
    if(Date.now()-start > timeoutMs) throw new Error("Timeout waiting for ESP32");
    const {value, done} = await reader.read();
    if(done) throw new Error("Serial closed");
    rxBuf += dec.decode(value);
  }
}
async function writeText(s){
  await writer.write(enc.encode(s));
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(s){ return String(s).replace(/["<>]/g,"_"); }
function safeName(name){ return String(name).replace(/[^\w.\-]/g,"_"); }

// --- IndexedDB (thumbnail cache) ---
function idbOpen(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(THUMB_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("thumbs");
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}
async function idbSet(key, blob){
  const db = await idbOpen();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction("thumbs","readwrite");
    tx.objectStore("thumbs").put(blob, key);
    tx.oncomplete = ()=>resolve();
    tx.onerror = ()=>reject(tx.error);
  });
}
async function idbGet(key){
  const db = await idbOpen();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction("thumbs","readonly");
    const req = tx.objectStore("thumbs").get(key);
    req.onsuccess = ()=>resolve(req.result || null);
    req.onerror = ()=>reject(req.error);
  });
}
async function idbDel(key){
  const db = await idbOpen();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction("thumbs","readwrite");
    tx.objectStore("thumbs").delete(key);
    tx.oncomplete = ()=>resolve();
    tx.onerror = ()=>reject(tx.error);
  });
}

// --- Connect ---
async function connect(){
  clearError();

  // WebSerial requirements
  if(!("serial" in navigator)){
    showError("WebSerial not supported. Use Chrome or Edge.");
    return;
  }
  if(!(location.protocol === "https:" || location.hostname === "localhost")){
    showError("WebSerial requires HTTPS (or localhost). Host this site on HTTPS (GitHub Pages / Netlify).");
    return;
  }

  try{
    setStatus("Opening port…");
    // MUST be called inside a click handler
    port = await navigator.serial.requestPort();
    await port.open({baudRate:115200});

    writer = port.writable.getWriter();
    reader = port.readable.getReader();
    rxBuf = "";

    setStatus("Connected ✅", true);
    disableUI(false);
    setUpload("Connected. Pick or drop a GIF, then Upload.");

    // read optional HELLO without failing connect
    try { await readLine(800); } catch {}

    await refreshList();
  } catch(e){
    showError("Connect failed: " + (e?.message || String(e)));
    setStatus("Not connected");
  }
}

// --- List/Play/Delete ---
async function refreshList(){
  clearError();
  gridEl.innerHTML = "";

  await writeText("LIST\n");

  const files = [];
  while(true){
    const line = await readLine();
    if(line === "BEGIN") continue;
    if(line === "END") break;
    if(line.startsWith("FILE ")){
      const parts = line.split(" ");
      files.push({name: parts[1], size: parts[2] || ""});
    }
  }

  if(files.length === 0){
    gridEl.innerHTML = `<div class="hint">No GIFs yet — upload one!</div>`;
    return;
  }

  for(const f of files){
    const card = document.createElement("div");
    card.className = "cardItem";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.innerHTML = `<div class="ph">No preview<br>(upload from this site to cache thumbnails)</div>`;

    // Try to load cached thumbnail blob
    try{
      const blob = await idbGet(f.name);
      if(blob){
        const url = URL.createObjectURL(blob);
        thumb.innerHTML = `<img alt="${escapeAttr(f.name)}" src="${url}">`;
      }
    } catch {}

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
        await writeText(`PLAY ${f.name}\n`);
        const resp = await readLine();
        if(resp !== "OK") throw new Error(resp);
        setUpload(`Playing: ${f.name}`, "good");
      } catch(e){
        showError("Play failed: " + (e?.message || String(e)));
      }
    };

    meta.querySelector(".del").onclick = async ()=>{
      if(!confirm(`Delete ${f.name}?`)) return;
      clearError();
      try{
        await writeText(`DEL ${f.name}\n`);
        const resp = await readLine();
        if(resp !== "OK") throw new Error(resp);
        await idbDel(f.name).catch(()=>{});
        await refreshList();
      } catch(e){
        showError("Delete failed: " + (e?.message || String(e)));
      }
    };

    card.appendChild(thumb);
    card.appendChild(meta);
    gridEl.appendChild(card);
  }
}

// --- GIF resize ---
function drawFit(ctx, img, tw, th, mode){
  const iw = img.width, ih = img.height;
  ctx.clearRect(0,0,tw,th);

  if(mode === "stretch"){
    ctx.drawImage(img, 0,0,tw,th);
    return;
  }
  const scaleContain = Math.min(tw/iw, th/ih);
  const scaleCover   = Math.max(tw/iw, th/ih);
  const s = (mode === "cover") ? scaleCover : scaleContain;

  const dw = Math.round(iw * s);
  const dh = Math.round(ih * s);
  const dx = Math.round((tw - dw)/2);
  const dy = Math.round((th - dh)/2);

  ctx.drawImage(img, dx, dy, dw, dh);
}

async function resizeGif(file){
  const buf = await file.arrayBuffer();
  const gifObj = window.gifuct.parseGIF(buf);
  const frames = window.gifuct.decompressFrames(gifObj, true);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = TARGET_W;
  outCanvas.height = TARGET_H;
  const outCtx = outCanvas.getContext("2d", { willReadFrequently: true });

  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = gifObj.lsd.width;
  srcCanvas.height = gifObj.lsd.height;
  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });

  const encoder = new window.GIF({
    workers: 2,
    quality: 10,
    width: TARGET_W,
    height: TARGET_H,
    workerScript: "https://unpkg.com/gif.js.optimized/dist/gif.worker.js"
  });

  for(const fr of frames){
    const imageData = srcCtx.createImageData(fr.dims.width, fr.dims.height);
    imageData.data.set(fr.patch);
    srcCtx.putImageData(imageData, fr.dims.left, fr.dims.top);

    drawFit(outCtx, srcCanvas, TARGET_W, TARGET_H, FIT_MODE);

    // delay in ms: gifuct usually gives 1/100s
    let delayMs = fr.delay != null ? fr.delay * 10 : 60;
    if(delayMs < 10) delayMs = 10;
    if(delayMs > 200) delayMs = 200;
    encoder.addFrame(outCtx, { copy:true, delay: delayMs });
  }

  const outBlob = await new Promise((resolve, reject)=>{
    encoder.on("finished", resolve);
    encoder.on("abort", ()=>reject(new Error("GIF encode aborted")));
    encoder.render();
  });

  const base = safeName(file.name.replace(/\.gif$/i,""));
  const outName = `${base}_${TARGET_W}x${TARGET_H}.gif`;
  return { blob: outBlob, name: outName };
}

// --- Upload using your ESP protocol ---
async function uploadBytes(name, bytes){
  await writeText(`UPLOAD2 ${name} ${bytes.length}\n`);

  const ready = await readLine(15000);
  if(ready !== "READY") throw new Error("Device refused: " + ready);

  // small delay helps stability
  await new Promise(r=>setTimeout(r, 20));

  const CHUNK = 1024;
  let sent = 0;

  while(sent < bytes.length){
    const len = Math.min(CHUNK, bytes.length - sent);
    await writeText(`C ${len}\n`);
    await writer.write(bytes.slice(sent, sent + len));
    sent += len;

    const ack = await readLine(15000);
    if(!ack.startsWith("ACK ")) throw new Error("Upload failed: " + ack);

    setUpload(`Uploading… ${Math.floor((sent/bytes.length)*100)}%`);
  }

  const done = await readLine(15000);
  if(done !== "OK") throw new Error("Upload failed: " + done);
}

async function uploadFlow(){
  clearError();
  const file = fileInput.files?.[0];
  if(!file){ setUpload("Pick a GIF first", "bad"); return; }
  if(!/\.gif$/i.test(file.name)){ setUpload("Choose a .gif file", "bad"); return; }

  setUpload(`Resizing to ${TARGET_W}×${TARGET_H}…`);
  const { blob, name } = await resizeGif(file);

  // cache thumbnail for grid preview (same gif blob)
  await idbSet(name, blob).catch(()=>{});

  const bytes = new Uint8Array(await blob.arrayBuffer());
  setUpload(`Uploading ${name}…`);

  await uploadBytes(name, bytes);

  setUpload(`Upload complete ✅ (${name})`, "good");
  await refreshList();
}

// --- Drag & drop (does NOT block clicks) ---
function setDropped(file){
  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  setUpload(`Dropped: ${file.name} (ready). Click Upload.`, "muted");
}

card.addEventListener("dragover", (e)=>{
  e.preventDefault();
  dropOverlay.classList.remove("hidden");
});
card.addEventListener("dragleave", ()=>{
  dropOverlay.classList.add("hidden");
});
card.addEventListener("drop", (e)=>{
  e.preventDefault();
  dropOverlay.classList.add("hidden");
  const files = Array.from(e.dataTransfer?.files || []);
  const gif = files.find(f => /\.gif$/i.test(f.name));
  if(!gif){ setUpload("Drop a .gif file", "bad"); return; }
  setDropped(gif);
});

// --- Buttons ---
disableUI(true);
setStatus("Not connected");
setUpload("Uploads go to your SD card");

connectBtn.onclick = async ()=>{
  await connect();
};

refreshBtn.onclick = async ()=>{
  try { await refreshList(); }
  catch(e){ showError("Refresh failed: " + (e?.message || String(e))); }
};

uploadBtn.onclick = async ()=>{
  try { await uploadFlow(); }
  catch(e){ showError(e?.message || String(e)); setUpload("Upload failed", "bad"); }
};
