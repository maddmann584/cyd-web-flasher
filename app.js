const connectBtn = document.getElementById("connectBtn");
const statusEl   = document.getElementById("status");
const fileInput  = document.getElementById("fileInput");
const uploadBtn  = document.getElementById("uploadBtn");
const refreshBtn = document.getElementById("refreshBtn");
const uploadStatus = document.getElementById("uploadStatus");
const listEl = document.getElementById("list");
const debugEl = document.getElementById("debug");

const card = document.getElementById("card");
const dropOverlay = document.getElementById("dropOverlay");

let port=null, reader=null, writer=null;
const dec = new TextDecoder();
const enc = new TextEncoder();
let rxBuf = "";

const TARGET_W = 240;   // ✅ your screen
const TARGET_H = 320;   // ✅ your screen
const FIT_MODE = "contain"; // contain | cover | stretch

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

  // Optional hello line
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

// ---------- Resize GIF to screen ----------
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

async function resizeGifTo240x320(file){
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

    // gifuct delay is usually in 1/100 seconds
    let delayMs = fr.delay != null ? fr.delay * 10 : 60;
    if(delayMs < 10) delayMs = 10;
    if(delayMs > 200) delayMs = 200;

    encoder.addFrame(outCtx, { copy: true, delay: delayMs });
  }

  const outBlob = await new Promise((resolve, reject)=>{
    encoder.on("finished", resolve);
    encoder.on("abort", ()=>reject(new Error("GIF encode aborted")));
    encoder.render();
  });

  const base = file.name.replace(/\.gif$/i,"").replace(/[^\w.\-]/g,"_");
  const newName = `${base}_${TARGET_W}x${TARGET_H}.gif`;
  return { blob: outBlob, name: newName };
}

// ---------- Upload (uses your firmware protocol) ----------
async function uploadBytes(name, bytes){
  setUpload(`Sending header… (${bytes.length} bytes)`);
  log(`TX: UPLOAD2 ${name} ${bytes.length}`);
  await writeText(`UPLOAD2 ${name} ${bytes.length}\n`);

  const ready = await readLine(15000);
  log("RX: " + ready);
  if(ready !== "READY") throw new Error("Device refused: " + ready);

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
    if(!ack.startsWith("ACK ")) throw new Error("Upload failed: " + ack);

    setUpload(`Uploading… ${Math.floor((sent/bytes.length)*100)}%`);
  }

  const done = await readLine(15000);
  log("RX: " + done);
  if(done !== "OK") throw new Error("Upload failed: " + done);
}

async function uploadReliable(){
  const file = fileInput.files?.[0];
  if(!file){ setUpload("Pick a GIF first","bad"); return; }

  setUpload(`Resizing to ${TARGET_W}x${TARGET_H}…`);
  log("Resizing: " + file.name);

  const { blob, name } = await resizeGifTo240x320(file);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const safeName = name.replace(/[^\w.\-]/g,"_");

  setUpload(`Uploading ${safeName}…`);
  await uploadBytes(safeName, bytes);

  setUpload("Upload complete ✅","good");
  await refreshList();
}

// ---------- Drag & drop (keeps old UI) ----------
function setDroppedFile(file){
  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  setUpload(`Dropped: ${file.name} (ready). Click Upload to /gifs`);
}

document.addEventListener("dragover", (e)=>{
  e.preventDefault();
  if(dropOverlay) dropOverlay.classList.remove("hidden");
});
document.addEventListener("dragleave", ()=>{
  if(dropOverlay) dropOverlay.classList.add("hidden");
});
document.addEventListener("drop", (e)=>{
  e.preventDefault();
  if(dropOverlay) dropOverlay.classList.add("hidden");

  const files = Array.from(e.dataTransfer?.files || []);
  const gif = files.find(f => /\.gif$/i.test(f.name));
  if(!gif){ setUpload("Drop a .gif file","bad"); return; }
  setDroppedFile(gif);
});

// ---------- UI wiring ----------
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
  try { await uploadReliable(); }
  catch(e){ console.error(e); log("ERROR: " + (e.message||e)); setUpload(e.message||String(e),"bad"); }
};
