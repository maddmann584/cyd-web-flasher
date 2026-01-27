// Maddmann GIF Player — app.js (FULL REWRITE)
// ✅ No debug box
// ✅ Connect popup works (with proper HTTPS + Chrome/Edge checks + clear errors)
// ✅ Grid menu with scroll
// ✅ NO duplicate entries (dedupe by filename + cancel stale refreshes)
// ✅ REAL GIF previews using firmware command: GET <name>
//    Firmware must support:
//      - GET <name>\n  -> replies "SIZE <n>\n" then sends exactly n raw bytes (the .gif file)
//
// ✅ Drag overlay only shows while dragging OVER the card

// ---------- DOM ----------
const connectBtn    = document.getElementById("connectBtn");
const statusEl      = document.getElementById("status");
const fileInput     = document.getElementById("fileInput");
const uploadBtn     = document.getElementById("uploadBtn");
const refreshBtn    = document.getElementById("refreshBtn");
const uploadStatus  = document.getElementById("uploadStatus");
const gridEl        = document.getElementById("grid");
const errorBox      = document.getElementById("errorBox");
const dropOverlay   = document.getElementById("dropOverlay");
const card          = document.getElementById("card");

// ---------- WebSerial ----------
let port = null, reader = null, writer = null;

// IMPORTANT: we do NOT decode random serial chunks as text anymore.
// We keep a raw byte queue and only decode lines when needed.
// This is the main fix for "preview doesn't work".
let rx = new Uint8Array(0);
const textDec = new TextDecoder();
const textEnc = new TextEncoder();

function concatBytes(a, b){
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function pump(timeoutMs = 15000){
  const start = Date.now();
  while (true){
    if (Date.now() - start > timeoutMs) throw new Error("Timeout waiting for device");
    const { value, done } = await reader.read();
    if (done) throw new Error("Serial closed");
    if (value && value.length){
      rx = concatBytes(rx, value);
      return;
    }
  }
}

async function readLine(timeoutMs = 15000){
  const start = Date.now();
  while (true){
    // find newline in raw buffer
    const idx = rx.indexOf(0x0A); // '\n'
    if (idx >= 0){
      const lineBytes = rx.slice(0, idx);      // excludes '\n'
      rx = rx.slice(idx + 1);

      // trim optional '\r'
      let lb = lineBytes;
      if (lb.length && lb[lb.length - 1] === 0x0D) lb = lb.slice(0, -1);

      const line = textDec.decode(lb).trim();
      return line;
    }

    if (Date.now() - start > timeoutMs) throw new Error("Timeout waiting for line");
    await pump(timeoutMs);
  }
}

async function readBytesExact(n, timeoutMs = 30000){
  const start = Date.now();
  while (rx.length < n){
    if (Date.now() - start > timeoutMs) throw new Error("Timeout waiting for bytes");
    await pump(timeoutMs);
  }
  const out = rx.slice(0, n);
  rx = rx.slice(n);
  return out;
}

async function writeText(s){
  await writer.write(textEnc.encode(s));
}

// ---------- UI helpers ----------
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
function disableUI(disabled){
  uploadBtn.disabled = disabled;
  refreshBtn.disabled = disabled;
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(s){ return String(s).replace(/["<>]/g,"_"); }
function safeName(name){ return String(name).replace(/[^\w.\-]/g,"_"); }

// ---------- Settings ----------
const TARGET_W = 240;
const TARGET_H = 320;
const FIT_MODE = "contain"; // contain | cover | stretch

// ---------- Preview cache (in-memory objectURLs) ----------
const previewURL = new Map(); // name -> objectURL
function setPreviewImg(thumbEl, name, blob){
  // reuse or replace
  if (previewURL.has(name)){
    const old = previewURL.get(name);
    try{ URL.revokeObjectURL(old); }catch{}
  }
  const url = URL.createObjectURL(blob);
  previewURL.set(name, url);
  thumbEl.innerHTML = `<img alt="${escapeAttr(name)}" src="${url}">`;
}
function clearPreviewCache(){
  for (const url of previewURL.values()){
    try{ URL.revokeObjectURL(url); }catch{}
  }
  previewURL.clear();
}

// ---------- Connect ----------
async function connect(){
  clearError();

  if (!("serial" in navigator)){
    showError("WebSerial not supported. Use Chrome or Edge.");
    return;
  }
  if (!(location.protocol === "https:" || location.hostname === "localhost")){
    showError("WebSerial needs HTTPS (or localhost). Host this site on GitHub Pages / Netlify.");
    return;
  }

  try{
    setStatus("Connecting…");
    // must be inside a user click
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });

    writer = port.writable.getWriter();
    reader = port.readable.getReader();
    rx = new Uint8Array(0);

    setStatus("Connected ✅", true);
    disableUI(false);
    setUpload("Connected. Drop or choose a GIF, then Upload.");

    // optional hello line (don’t fail if absent)
    try { await readLine(800); } catch {}

    await refreshList();
  } catch(e){
    setStatus("Not connected");
    showError("Connect failed: " + (e?.message || String(e)));
  }
}

// ---------- Firmware commands ----------
async function cmdLIST(){
  await writeText("LIST\n");
  const map = new Map();

  while (true){
    const line = await readLine(15000);
    if (line === "BEGIN") continue;
    if (line === "END") break;

    if (line.startsWith("FILE ")){
      const parts = line.split(" ");
      const name = parts[1];
      const size = parts[2] || "";
      if (!map.has(name)) map.set(name, { name, size });
    }
  }
  return Array.from(map.values());
}

async function cmdPLAY(name){
  await writeText(`PLAY ${name}\n`);
  const resp = await readLine(15000);
  if (resp !== "OK") throw new Error(resp);
}

async function cmdDEL(name){
  await writeText(`DEL ${name}\n`);
  const resp = await readLine(15000);
  if (resp !== "OK") throw new Error(resp);
}

async function cmdGET(name){
  // Firmware must reply: "SIZE <n>\n" then raw bytes
  await writeText(`GET ${name}\n`);
  const header = await readLine(15000);
  if (!header.startsWith("SIZE ")) throw new Error("GET failed: " + header);

  const n = parseInt(header.slice(5), 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Bad SIZE: " + header);

  const bytes = await readBytesExact(n, 60000);
  return new Blob([bytes], { type: "image/gif" });
}

// ---------- Grid rendering (dedupe + no duplicates) ----------
let refreshSeq = 0;

async function refreshList(){
  clearError();
  const mySeq = ++refreshSeq;

  gridEl.innerHTML = "";
  setUpload("Loading GIF list…");

  let files = [];
  try{
    files = await cmdLIST();
  } catch(e){
    setUpload("List failed", "bad");
    showError("LIST failed: " + (e?.message || String(e)));
    return;
  }

  if (mySeq !== refreshSeq) return; // stale

  if (!files.length){
    gridEl.innerHTML = `<div class="hint">No GIFs yet — upload one!</div>`;
    setUpload("No GIFs yet.");
    return;
  }

  setUpload(`Found ${files.length} GIF(s).`);

  for (const f of files){
    const cardItem = document.createElement("div");
    cardItem.className = "cardItem";

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
        await cmdPLAY(f.name);
        setUpload(`Playing: ${f.name}`, "good");
      } catch(e){
        setUpload("Play failed", "bad");
        showError("Play failed: " + (e?.message || String(e)));
      }
    };

    meta.querySelector(".del").onclick = async ()=>{
      if (!confirm(`Delete ${f.name}?`)) return;
      clearError();
      try{
        setUpload(`Deleting: ${f.name}…`);
        await cmdDEL(f.name);

        // cleanup preview url
        if (previewURL.has(f.name)){
          try{ URL.revokeObjectURL(previewURL.get(f.name)); }catch{}
          previewURL.delete(f.name);
        }

        setUpload("Deleted.", "good");
        await refreshList();
      } catch(e){
        setUpload("Delete failed", "bad");
        showError("Delete failed: " + (e?.message || String(e)));
      }
    };

    cardItem.appendChild(thumb);
    cardItem.appendChild(meta);
    gridEl.appendChild(cardItem);

    // Preview load (real preview via GET)
    (async ()=>{
      try{
        if (mySeq !== refreshSeq) return;

        // already cached?
        if (previewURL.has(f.name)){
          thumb.innerHTML = `<img alt="${escapeAttr(f.name)}" src="${previewURL.get(f.name)}">`;
          return;
        }

        const blob = await cmdGET(f.name);
        if (mySeq !== refreshSeq) return;

        setPreviewImg(thumb, f.name, blob);
      } catch(e){
        // Most common reason if this fails: firmware doesn't have GET command yet.
        thumb.innerHTML = `<div class="ph">No preview</div>`;
      }
    })();
  }
}

// ---------- GIF resize + upload ----------
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
  const outCtx = outCanvas.getContext("2d", { willReadFrequently:true });

  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = gifObj.lsd.width;
  srcCanvas.height = gifObj.lsd.height;
  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently:true });

  const encoder = new window.GIF({
    workers: 2,
    quality: 10,
    width: TARGET_W,
    height: TARGET_H,
    workerScript: "https://unpkg.com/gif.js.optimized/dist/gif.worker.js"
  });

  for (const fr of frames){
    const imageData = srcCtx.createImageData(fr.dims.width, fr.dims.height);
    imageData.data.set(fr.patch);
    srcCtx.putImageData(imageData, fr.dims.left, fr.dims.top);

    drawFit(outCtx, srcCanvas, TARGET_W, TARGET_H, FIT_MODE);

    let delayMs = fr.delay != null ? fr.delay * 10 : 60;
    if (delayMs < 10) delayMs = 10;
    if (delayMs > 200) delayMs = 200;

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

async function uploadBytes(name, bytes){
  await writeText(`UPLOAD2 ${name} ${bytes.length}\n`);

  const ready = await readLine(20000);
  if (ready !== "READY") throw new Error("Device refused: " + ready);

  await new Promise(r=>setTimeout(r, 20));

  const CHUNK = 1024;
  let sent = 0;

  while (sent < bytes.length){
    const len = Math.min(CHUNK, bytes.length - sent);
    await writeText(`C ${len}\n`);
    await writer.write(bytes.slice(sent, sent + len));
    sent += len;

    const ack = await readLine(20000);
    if (!ack.startsWith("ACK ")) throw new Error("Upload failed: " + ack);

    setUpload(`Uploading… ${Math.floor((sent/bytes.length)*100)}%`);
  }

  const done = await readLine(20000);
  if (done !== "OK") throw new Error("Upload failed: " + done);
}

async function uploadFlow(){
  clearError();
  const file = fileInput.files?.[0];
  if (!file){ setUpload("Pick a GIF first", "bad"); return; }
  if (!/\.gif$/i.test(file.name)){ setUpload("Choose a .gif file", "bad"); return; }

  setUpload(`Resizing to ${TARGET_W}×${TARGET_H}…`);
  const { blob, name } = await resizeGif(file);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  setUpload(`Uploading ${name}…`);
  await uploadBytes(name, bytes);

  setUpload(`Upload complete ✅ (${name})`, "good");

  // after upload, refresh list (previews will now work via GET)
  await refreshList();
}

// ---------- Drag overlay: ONLY shows while dragging over card ----------
let dragDepth = 0;
function showDrop(){ dropOverlay.classList.remove("hidden"); }
function hideDrop(){ dropOverlay.classList.add("hidden"); dragDepth = 0; }

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
  if (dragDepth <= 0) hideDrop();
});
card.addEventListener("drop", (e)=>{
  e.preventDefault();
  hideDrop();

  const files = Array.from(e.dataTransfer?.files || []);
  const gif = files.find(f => /\.gif$/i.test(f.name));
  if (!gif){ setUpload("Drop a .gif file", "bad"); return; }

  const dt = new DataTransfer();
  dt.items.add(gif);
  fileInput.files = dt.files;

  setUpload(`Dropped: ${gif.name} (ready). Click Upload.`, "muted");
});

// ---------- Buttons ----------
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
  catch(e){
    setUpload("Upload failed", "bad");
    showError(e?.message || String(e));
  }
};
