const connectBtn = document.getElementById("connectBtn");
const statusEl   = document.getElementById("status");
const fileInput  = document.getElementById("fileInput");
const uploadBtn  = document.getElementById("uploadBtn");
const refreshBtn = document.getElementById("refreshBtn");
const uploadStatus = document.getElementById("uploadStatus");
const listEl = document.getElementById("list");
const debugEl = document.getElementById("debug");

let port=null, reader=null, writer=null;
const dec = new TextDecoder();
const enc = new TextEncoder();

// ✅ binary-safe buffer
let rx = new Uint8Array(0);

function log(msg){
  debugEl.textContent += msg + "\n";
  debugEl.scrollTop = debugEl.scrollHeight;
  console.log(msg);
}

function setStatus(msg, kind="warn"){
  statusEl.textContent = msg;
  statusEl.style.color =
    kind==="good" ? "#00ff88" :
    kind==="bad"  ? "#ff4d4d" :
    "#ffaa00";
}

function setUpload(msg, kind="warn"){
  uploadStatus.textContent = msg;
  uploadStatus.style.color =
    kind==="good" ? "#00ff88" :
    kind==="bad"  ? "#ff4d4d" :
    "#a8a8b3";
}

function disableUI(disabled){
  uploadBtn.disabled = disabled;
  refreshBtn.disabled = disabled;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(s){ return String(s).replace(/["<>]/g,"_"); }

function rxAppend(chunk){
  const b = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  const out = new Uint8Array(rx.length + b.length);
  out.set(rx, 0);
  out.set(b, rx.length);
  rx = out;
}

async function readLine(timeoutMs=12000){
  const start = Date.now();
  while(true){
    for(let i=0;i<rx.length;i++){
      if(rx[i] === 10){ // \n
        let lineBytes = rx.slice(0, i);
        rx = rx.slice(i+1);
        if(lineBytes.length && lineBytes[lineBytes.length-1] === 13) lineBytes = lineBytes.slice(0,-1);
        return dec.decode(lineBytes).trim();
      }
    }
    if(Date.now()-start > timeoutMs) throw new Error("Timeout waiting for line");
    const {value, done} = await reader.read();
    if(done) throw new Error("Serial closed");
    rxAppend(value);
  }
}

async function readBytesExact(n, timeoutMs=30000){
  const start = Date.now();
  const out = new Uint8Array(n);
  let off = 0;

  while(off < n){
    if(rx.length){
      const take = Math.min(rx.length, n - off);
      out.set(rx.slice(0, take), off);
      rx = rx.slice(take);
      off += take;
      continue;
    }
    if(Date.now()-start > timeoutMs) throw new Error("Timeout waiting for bytes");
    const {value, done} = await reader.read();
    if(done) throw new Error("Serial closed");
    rxAppend(value);
  }
  return out;
}

async function writeText(s){
  await writer.write(enc.encode(s));
}

async function connect(){
  if(!("serial" in navigator)) throw new Error("WebSerial not supported. Use Chrome/Edge.");

  log("Requesting port…");
  port = await navigator.serial.requestPort();

  log("Opening @115200…");
  await port.open({ baudRate:115200 });

  writer = port.writable.getWriter();
  reader = port.readable.getReader();
  rx = new Uint8Array(0);

  setStatus("Connected ✅","good");
  disableUI(false);

  // optional HELLO
  try {
    const hello = await readLine(1200);
    log("HELLO? RX: " + hello);
  } catch {
    log("No HELLO line (ok).");
  }

  try { await refreshList(); }
  catch(e){
    log("Refresh failed (still connected): " + (e.message||e));
    setUpload("Connected, but refresh failed. Click Refresh.", "warn");
  }
}

async function getGifFromDevice(name){
  // keep debug calm
  log("GET " + name);

  await writeText(`GET ${name}\n`);

  const sizeLine = await readLine(15000); // SIZE n
  if(!sizeLine.startsWith("SIZE ")) throw new Error("Bad GET response: " + sizeLine);

  const size = parseInt(sizeLine.slice(5), 10);
  if(!Number.isFinite(size) || size <= 0) throw new Error("Bad SIZE: " + sizeLine);

  // Safety: huge files will take ages to preview
  const MAX_PREVIEW = 3_000_000; // 3MB
  if(size > MAX_PREVIEW) throw new Error(`Too big to preview (${size} bytes)`);

  const bytes = await readBytesExact(size, 30000 + Math.floor(size / 40));

  const ok = await readLine(15000);
  if(ok !== "OK") throw new Error("GET end not OK: " + ok);

  return bytes;
}

async function refreshList(){
  listEl.innerHTML = "";
  setUpload("Refreshing…");
  log("LIST");

  await writeText("LIST\n");

  const fileMap = new Map();

  while(true){
    const line = await readLine(15000);
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

  const cards = new Map();

  for(const f of files){
    const card = document.createElement("div");
    card.className = "gif-card";
    card.innerHTML = `
      <div class="thumb-wrap"><div class="thumb loading">Loading preview…</div></div>
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

  listEl.querySelectorAll("[data-play]").forEach(btn=>{
    btn.onclick = async ()=>{
      const name = btn.getAttribute("data-play");
      log("PLAY " + name);
      await writeText(`PLAY ${name}\n`);
      const resp = await readLine(8000);
      if(resp !== "OK") alert("Play failed: " + resp);
    };
  });

  listEl.querySelectorAll("[data-del]").forEach(btn=>{
    btn.onclick = async ()=>{
      const name = btn.getAttribute("data-del");
      if(!confirm(`Delete ${name}?`)) return;
      log("DEL " + name);
      await writeText(`DEL ${name}\n`);
      const resp = await readLine(12000);
      if(resp === "OK") await refreshList();
      else alert("Delete failed: " + resp);
    };
  });

  // previews one-by-one
  for(const f of files){
    const card = cards.get(f.name);
    if(!card) continue;

    try{
      setUpload(`Previewing ${f.name}…`);
      const bytes = await getGifFromDevice(f.name);
      const blob = new Blob([bytes], { type: "image/gif" });
      const url = URL.createObjectURL(blob);
      card.querySelector(".thumb-wrap").innerHTML = `<img class="thumb-img" src="${url}" alt="${escapeAttr(f.name)}">`;
    }catch(e){
      card.querySelector(".thumb-wrap").innerHTML = `<div class="thumb error">${escapeHtml(e.message || "No preview")}</div>`;
    }
  }

  setUpload("Ready ✅","good");
}

async function uploadReliable(){
  const file = fileInput.files?.[0];
  if(!file){ setUpload("Pick a GIF first","bad"); return; }

  const safeName = file.name.replace(/[^\w.\-]/g,"_");
  const bytes = new Uint8Array(await file.arrayBuffer());

  setUpload(`Sending header… (${bytes.length} bytes)`);
  log(`UPLOAD2 ${safeName} ${bytes.length}`);
  await writeText(`UPLOAD2 ${safeName} ${bytes.length}\n`);

  const ready = await readLine(15000);
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
    if(!ack.startsWith("ACK ")){ setUpload("Upload failed: " + ack,"bad"); return; }
    setUpload(`Uploading… ${Math.floor((sent/bytes.length)*100)}%`);
  }

  const done = await readLine(15000);
  if(done === "OK"){
    setUpload("Upload complete ✅","good");
    await refreshList();
  } else {
    setUpload("Upload failed: " + done,"bad");
  }
}

// init
disableUI(true);
setStatus("Not connected","warn");
setUpload("Uploads go to /gifs");

connectBtn.onclick = async ()=>{ try { await connect(); } catch(e){ log("ERROR: " + (e.message||e)); setStatus("Connect failed","bad"); } };
refreshBtn.onclick = async ()=>{ try { await refreshList(); } catch(e){ log("ERROR: " + (e.message||e)); setUpload(e.message||String(e),"bad"); } };
uploadBtn.onclick  = async ()=>{ try { await uploadReliable(); } catch(e){ log("ERROR: " + (e.message||e)); setUpload(e.message||String(e),"bad"); } };
