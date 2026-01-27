const connectBtn = document.getElementById("connectBtn");
const statusEl   = document.getElementById("status");
const fileInput  = document.getElementById("fileInput");
const uploadBtn  = document.getElementById("uploadBtn");
const refreshBtn = document.getElementById("refreshBtn");
const uploadStatus = document.getElementById("uploadStatus");
const listEl = document.getElementById("list");
const debugEl = document.getElementById("debug");

const dropZone = document.getElementById("dropZone");
const targetSizeEl = document.getElementById("targetSize");
const fitModeEl = document.getElementById("fitMode");

let port=null, reader=null, writer=null;
const dec = new TextDecoder();
const enc = new TextEncoder();
let rxBuf = "";

function log(msg){
  debugEl.textContent += msg + "\n";
  debugEl.scrollTop = debugEl.scrollHeight;
  console.log(msg);
}
function setStatus(msg, kind="warn"){
  statusEl.textContent = msg;
  statusEl.style.color = kind==="good" ? "#00ff88" : kind==="bad" ? "#ff4d4d" : "#ffaa00";
}
function setUpload(msg, kind="warn"){
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

async function connect(){
  if(!("serial" in navigator)) throw new Error("WebSerial not supported. Use Chrome/Edge.");

  log("Requesting port...");
  port = await navigator.serial.requestPort();

  log("Opening @115200...");
  await port.open({baudRate:115200});

  writer = port.writable.getWriter();
  reader = port.readable.getReader();
  rxBuf = "";

  setStatus("Connected ✅","good");
  disableUI(false);

  // Optional hello
  try {
    const hello = await readLine(1500);
    log("RX: " + hello);
  } catch {
    log("No HELLO line (ok).");
  }

  await refreshList();
}

async function refreshList(){
  listEl.innerHTML = "";
  log("TX: LIST");
  await writeText("LIST\n");

  const files = [];
  while(true){
    const line = await readLine();
    log("RX: " + line);
    if(line === "BEGIN") continue;
    if(line === "END") break;
    if(line.startsWith("FILE ")){
      const parts = line.split(" ");
      files.push({name: parts[1], size: parts[2] || ""});
    }
  }

  if(files.length === 0){
    listEl.innerHTML = `<div class="hint">No GIFs in /gifs</div>`;
    return;
  }

  for(const f of files){
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div>
        <div class="name">${escapeHtml(f.name)}</div>
        <div class="meta">${escapeHtml(f.size)} bytes</div>
      </div>
      <div class="actions">
        <button class="play" data-play="${escapeAttr(f.name)}">Play</button>
        <button class="del" data-del="${escapeAttr(f.name)}">Delete</button>
      </div>
    `;
    listEl.appendChild(row);
  }

  listEl.querySelectorAll("[data-play]").forEach(btn=>{
    btn.onclick = async ()=>{
      const name = btn.getAttribute("data-play");
      log("TX: PLAY " + name);
      await writeText(`PLAY ${name}\n`);
      const resp = await readLine();
      log("RX: " + resp);
      if(resp !== "OK") alert("Play failed: " + resp);
    };
  });

  listEl.querySelectorAll("[data-del]").forEach(btn=>{
    btn.onclick = async ()=>{
      const name = btn.getAttribute("data-del");
      if(!confirm(`Delete ${name}?`)) return;
      log("TX: DEL " + name);
      await writeText(`DEL ${name}\n`);
      const resp = await readLine();
      log("RX: " + resp);
      if(resp === "OK") await refreshList();
      else alert("Delete failed: " + resp);
    };
  });
}

// ---------- GIF resize + re-encode ----------

// parse "240x320" etc
function getTargetWH(){
  const [w,h] = targetSizeEl.value.split("x").map(n=>parseInt(n,10));
  return {w,h};
}

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

async function resizeGifToScreen(file, tw, th, fitMode){
  const buf = await file.arrayBuffer();
  const gifObj = window.gifuct.parseGIF(buf);
  const frames = window.gifuct.decompressFrames(gifObj, true); // true => build patches

  // Offscreen canvases
  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  // We build a full RGBA frame each time using gifuct patches
  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = gifObj.lsd.width;
  srcCanvas.height = gifObj.lsd.height;
  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });

  // Encoder
  const encoder = new window.GIF({
    workers: 2,
    quality: 10,
    width: tw,
    height: th,
    workerScript: "https://unpkg.com/gif.js.optimized/dist/gif.worker.js"
  });

  // For each frame: draw patch into srcCanvas, then scale to target canvas, add to encoder
  for(let i=0;i<frames.length;i++){
    const fr = frames[i];

    // draw patch into src canvas at correct position
    const imageData = srcCtx.createImageData(fr.dims.width, fr.dims.height);
    imageData.data.set(fr.patch);
    srcCtx.putImageData(imageData, fr.dims.left, fr.dims.top);

    // scale to target
    drawFit(ctx, srcCanvas, tw, th, fitMode);

    // frame delay in ms (gifuct gives delay in hundredths sometimes; normalize)
    let delayMs = fr.delay != null ? fr.delay * 10 : 60; // fr.delay is usually in 1/100s
    if(delayMs < 10) delayMs = 10;
    if(delayMs > 200) delayMs = 200; // keep sane for your player

    encoder.addFrame(ctx, { copy: true, delay: delayMs });
  }

  // render to blob
  const outBlob = await new Promise((resolve, reject)=>{
    encoder.on("finished", resolve);
    encoder.on("abort", ()=>reject(new Error("GIF encode aborted")));
    encoder.render();
  });

  // Make a new filename
  const base = file.name.replace(/\.gif$/i,"");
  const newName = `${base}_${tw}x${th}.gif`;

  return { blob: outBlob, name: newName };
}

// ---------- Upload ----------
async function uploadOne(name, bytes){
  setUpload(`Sending header… (${bytes.length} bytes)`);
  log(`TX: UPLOAD2 ${name} ${bytes.length}`);
  await writeText(`UPLOAD2 ${name} ${bytes.length}\n`);

  const ready = await readLine(15000);
  log("RX: " + ready);
  if(ready !== "READY"){ throw new Error("Device refused: " + ready); }

  await new Promise(r=>setTimeout(r, 20));

  const CHUNK = 1024;
  let sent = 0;

  while(sent < bytes.length){
    const len = Math.min(CHUNK, bytes.length - sent);
    await writeText(`C ${len}\n`);
    await writer.write(bytes.slice(sent, sent + len));
    sent += len;

    const ack = await readLine(15000);
    log("RX: " + ack);
    if(!ack.startsWith("ACK ")){ throw new Error("Upload failed: " + ack); }

    setUpload(`Uploading… ${Math.floor((sent/bytes.length)*100)}%`);
  }

  const done = await readLine(15000);
  log("RX: " + done);
  if(done !== "OK"){ throw new Error("Upload failed: " + done); }
}

async function uploadSelectedFiles(){
  const files = fileInput.files ? Array.from(fileInput.files) : [];
  if(!files.length){ setUpload("Pick GIF(s) first","bad"); return; }

  const {w, h} = getTargetWH();
  const fitMode = fitModeEl.value;

  for(let idx=0; idx<files.length; idx++){
    const file = files[idx];
    if(!/\.gif$/i.test(file.name)){
      setUpload(`Skipping non-GIF: ${file.name}`,"warn");
      continue;
    }

    setUpload(`Resizing ${file.name} → ${w}x${h} (${fitMode})…`);
    log(`Resizing: ${file.name}`);

    const { blob, name } = await resizeGifToScreen(file, w, h, fitMode);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    setUpload(`Uploading ${name} (${bytes.length} bytes)…`);
    await uploadOne(name.replace(/[^\w.\-]/g,"_"), bytes);

    setUpload(`Uploaded ✅ ${name}`,"good");
  }

  await refreshList();
}

// ---------- Drag & drop ----------
function setFilesFromDrop(fileList){
  const dt = new DataTransfer();
  for (const f of fileList) dt.items.add(f);
  fileInput.files = dt.files;
  setUpload(`${dt.files.length} file(s) ready. Click “Resize + Upload”.`, "warn");
}

dropZone.addEventListener("dragover", (e)=>{
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", ()=>{
  dropZone.classList.remove("dragover");
});
dropZone.addEventListener("drop", (e)=>{
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const files = Array.from(e.dataTransfer.files || []).filter(f=>/\.gif$/i.test(f.name));
  if(!files.length){ setUpload("Drop GIF files only", "bad"); return; }
  setFilesFromDrop(files);
});

disableUI(true);
setStatus("Not connected","warn");
setUpload("Uploads go to /gifs");

connectBtn.onclick = async ()=>{
  try { await connect(); }
  catch(e){ console.error(e); log("ERROR: " + (e.message||e)); setStatus("Connect failed","bad"); }
};

refreshBtn.onclick = async ()=>{
  try { await refreshList(); }
  catch(e){ console.error(e); log("ERROR: " + (e.message||e)); alert(e.message||String(e)); }
};

uploadBtn.onclick = async ()=>{
  try { await uploadSelectedFiles(); }
  catch(e){ console.error(e); log("ERROR: " + (e.message||e)); setUpload(e.message||String(e),"bad"); }
};
