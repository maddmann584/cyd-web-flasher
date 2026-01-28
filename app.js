const connectBtn = document.getElementById("connectBtn");
const statusEl   = document.getElementById("status");
const fileInput  = document.getElementById("fileInput");
const uploadBtn  = document.getElementById("uploadBtn");
const refreshBtn = document.getElementById("refreshBtn");
const uploadStatus = document.getElementById("uploadStatus");
const listEl = document.getElementById("list");
const debugEl = document.getElementById("debug");

let port = null, reader = null, writer = null;
const dec = new TextDecoder();
const enc = new TextEncoder();

// ✅ BYTE BUFFER (binary-safe)
let rx = new Uint8Array(0);

function log(msg){
  debugEl.textContent += msg + "\n";
  debugEl.scrollTop = debugEl.scrollHeight;
  console.log(msg);
}

function setStatus(msg, kind="warn"){
  statusEl.textContent = msg;
  statusEl.style.color =
    kind === "good" ? "#00ff88" :
    kind === "bad"  ? "#ff4d4d" :
    "#ffaa00";
}

function setUpload(msg, kind="warn"){
  uploadStatus.textContent = msg;
  uploadStatus.style.color =
    kind === "good" ? "#00ff88" :
    kind === "bad"  ? "#ff4d4d" :
    "#a8a8b3";
}

function disableUI(disabled){
  uploadBtn.disabled = disabled;
  refreshBtn.disabled = disabled;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function escapeAttr(s){ return String(s).replace(/["<>]/g,"_"); }

async function writeText(s){
  await writer.write(enc.encode(s));
}

/* ===========================
   ✅ Binary-safe serial helpers
   =========================== */

function rxAppend(chunk){
  const b = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  const out = new Uint8Array(rx.length + b.length);
  out.set(rx, 0);
  out.set(b, rx.length);
  rx = out;
}

async function readMore(timeoutMs=12000){
  const start = Date.now();
  while(rx.length === 0){
    if(Date.now() - start > timeoutMs) throw new Error("Timeout waiting for ESP32");
    const { value, done } = await reader.read();
    if(done) throw new Error("Serial closed");
    rxAppend(value);
  }
}

async function readLine(timeoutMs=12000){
  const start = Date.now();
  while(true){
    // find LF
    for(let i=0;i<rx.length;i++){
      if(rx[i] === 10){ // '\n'
        let lineBytes = rx.slice(0, i);     // exclude '\n'
        rx = rx.slice(i+1);

        // trim CR
        if(lineBytes.length && lineBytes[lineBytes.length-1] === 13) {
          lineBytes = lineBytes.slice(0, -1);
        }

        const line = dec.decode(lineBytes).trim();
        return line;
      }
    }

    if(Date.now() - start > timeoutMs) throw new Error("Timeout waiting for line");
    const { value, done } = await reader.read();
    if(done) throw new Error("Serial closed");
    rxAppend(value);
  }
}

async function readBytesExact(n, timeoutMs=25000){
  const start = Date.now();
  const out = new Uint8Array(n);
  let off = 0;

  while(off < n){
    // take from rx first
    if(rx.length){
      const take = Math.min(rx.length, n - off);
      out.set(rx.slice(0, take), off);
      rx = rx.slice(take);
      off += take;
      continue;
    }

    if(Date.now() - start > timeoutMs) throw new Error("Timeout waiting for bytes");
    const { value, done } = await reader.read();
    if(done) throw new Error("Serial closed");
    rxAppend(value);
  }

  return out;
}

/* ===========================
   ✅ Device GET for previews
   =========================== */

async function getGifFromDevice(name){
  log("TX: GET " + name);
  await writeText(`GET ${name}\n`);

  const sizeLine = await readLine(15000); // SIZE N
  log("RX: " + sizeLine);
  if(!sizeLine.startsWith("SIZE ")) throw new Error("Bad GET response: " + sizeLine);

  const size = parseInt(sizeLine.slice(5), 10);
  if(!Number.isFinite(size) || size <= 0) throw new Error("Bad SIZE: " + sizeLine);

  const bytes = await readBytesExact(size, 30000 + Math.floor(size / 40));

  // after bytes, firmware sends blank line then OK
  while(true){
    const line = await readLine(15000);
    log("RX: " + line);
    if(line.length === 0) continue;
    if(line === "OK") break;
    if(line.startsWith("ERR")) throw new Error(line);
  }

  return bytes;
}

/* ===========================
   Connect / List / Grid
   =========================== */

async function connect(){
  if(!("serial" in navigator)) throw new Error("WebSerial not supported. Use Chrome/Edge.");

  log("Requesting port...");
  port = await navigator.serial.requestPort();

  log("Opening @115200...");
  await port.open({ baudRate:115200 });

  writer = port.writable.getWriter();
  reader = port.readable.getReader();
  rx = new Uint8Array(0);

  setStatus("Connected ✅","good");
  disableUI(false);

  // optional HELLO
  try {
    const hello = await readLine(1200);
    log("RX: " + hello);
  } catch {
    log("No HELLO line (ok).");
  }

  // don't fail connect if refresh fails
  try { await refreshList(); }
  catch(e){
    log("Refresh failed (still connected): " + (e.message||e));
    setUpload("Connected, but refresh failed. Click Refresh.", "warn");
  }
}

async function refreshList(){
  listEl.innerHTML = "";
  setUpload("Refreshing…");
  log("TX: LIST");
  await writeText("LIST\n");

  const fileMap = new Map();

  while(true){
    const line = await readLine(15000);
    log("RX: " + line);

    if(line === "BEGIN") continue;
    if(line === "END") break;

    if(line.startsWith("FILE ")){
      const parts = line.split(" ");
      const name = (parts[1] || "").trim();
      const size = (parts[2] || "").trim();
      if(name) fileMap.set(name, { name, size });
    }
  }

  const files = Array.from(fileMap.values()).sort((a,b)=>a.name.localeCompare(b.name));

  if(files.length === 0){
    listEl.innerHTML = `<div class="hint">No GIFs in /gifs</div>`;
    setUpload("No files found");
    return;
  }

  // build cards first
  const cards = new Map();
  for(const f of files){
    const card = document.createElement("div");
    card.className = "gif-card";
    card.innerHTML = `
      <div class="thumb-wrap">
        <div class="thumb loading">Loading preview…</div>
      </div>
      <div class="gif-name" title="${escapeAttr(f.name)}">${escapeHtml(f.name)}</div>
      <div class="gif-meta">${escapeHtml(f.size)} bytes</div>
      <div class="gif-actions">
        <button class="play" data-play="${escapeAttr(f.name)}">Play</button>
        <button class="del" data-del="${escapeAttr(f.name)}">Delete</button>
      </div>
    `;
    listEl.appendChild(card);
    cards.set(f.name, card);
  }

  // buttons
  listEl.querySelectorAll("[data-play]").forEach(btn=>{
    btn.onclick = async ()=>{
      const name = btn.getAttribute("data-play");
      log("TX: PLAY " + name);
      await writeText(`PLAY ${name}\n`);
      const resp = await readLine(8000);
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
      const resp = await readLine(12000);
      log("RX: " + resp);
      if(resp === "OK") await refreshList();
      else alert("Delete failed: " + resp);
    };
  });

  // previews one-by-one
  for(const f of files){
    const card = cards.get(f.name);
    if(!card) continue;

    try{
      setUpload(`Preview: ${f.name}`);
      const bytes = await getGifFromDevice(f.name);

      const blob = new Blob([bytes], { type: "image/gif" });
      const url = URL.createObjectURL(blob);

      const wrap = card.querySelector(".thumb-wrap");
      wrap.innerHTML = `<img class="thumb-img" src="${url}" alt="${escapeAttr(f.name)}">`;
    }catch(e){
      console.error(e);
      const wrap = card.querySelector(".thumb-wrap");
      wrap.innerHTML = `<div class="thumb error">No preview</div>`;
    }
  }

  setUpload("Ready ✅","good");
}

/* ===========================
   Upload (same protocol)
   =========================== */

async function uploadReliable(){
  const file = fileInput.files?.[0];
  if(!file){ setUpload("Pick a GIF first","bad"); return; }

  const safeName = file.name.replace(/[^\w.\-]/g,"_");
  const bytes = new Uint8Array(await file.arrayBuffer());

  setUpload(`Sending header… (${bytes.length} bytes)`);
  log(`TX: UPLOAD2 ${safeName} ${bytes.length}`);
  await writeText(`UPLOAD2 ${safeName} ${bytes.length}\n`);

  const ready = await readLine(15000);
  log("RX: " + ready);
  if(ready !== "READY"){ setUpload("Device refused: " + ready,"bad"); return; }

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
    if(!ack.startsWith("ACK ")){ setUpload("Upload failed: " + ack,"bad"); return; }

    setUpload(`Uploading… ${Math.floor((sent/bytes.length)*100)}%`);
  }

  const done = await readLine(15000);
  log("RX: " + done);

  if(done === "OK"){
    setUpload("Upload complete ✅","good");
    await refreshList();
  } else {
    setUpload("Upload failed: " + done,"bad");
  }
}

/* ===========================
   Init + Events
   =========================== */

disableUI(true);
setStatus("Not connected","warn");
setUpload("Uploads go to /gifs");

connectBtn.onclick = async ()=>{
  try { await connect(); }
  catch(e){ console.error(e); log("ERROR: " + (e.message||e)); setStatus("Connect failed","bad"); }
};

refreshBtn.onclick = async ()=>{
  try { await refreshList(); }
  catch(e){ console.error(e); log("ERROR: " + (e.message||e)); setUpload(e.message||String(e),"bad"); }
};

uploadBtn.onclick = async ()=>{
  try { await uploadReliable(); }
  catch(e){ console.error(e); log("ERROR: " + (e.message||e)); setUpload(e.message||String(e),"bad"); }
};
