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
let rxBuf = "";

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

async function readLine(timeoutMs=12000){
  const start = Date.now();
  while(true){
    const idx = rxBuf.indexOf("\n");
    if(idx >= 0){
      const line = rxBuf.slice(0, idx).replace("\r","").trim();
      rxBuf = rxBuf.slice(idx+1);
      return line;
    }
    if(Date.now() - start > timeoutMs) throw new Error("Timeout waiting for ESP32");
    const { value, done } = await reader.read();
    if(done) throw new Error("Serial closed");
    rxBuf += dec.decode(value);
  }
}

async function writeText(s){
  await writer.write(enc.encode(s));
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function escapeAttr(s){
  return String(s).replace(/["<>]/g, "_");
}

async function connect(){
  if(!("serial" in navigator)) throw new Error("WebSerial not supported. Use Chrome/Edge.");

  log("Requesting port...");
  port = await navigator.serial.requestPort();

  log("Opening @115200...");
  await port.open({ baudRate: 115200 });

  writer = port.writable.getWriter();
  reader = port.readable.getReader();
  rxBuf = "";

  setStatus("Connected ✅", "good");
  disableUI(false);

  // optional hello
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

  // Use a Map to dedupe by filename (prevents duplicates showing twice)
  // If the ESP reports the same filename twice, the last one wins.
  const fileMap = new Map();

  while(true){
    const line = await readLine();
    log("RX: " + line);

    if(line === "BEGIN") continue;
    if(line === "END") break;

    if(line.startsWith("FILE ")){
      const parts = line.split(" ");
      const name = parts[1] || "";
      const size = parts[2] || "";
      if(name) fileMap.set(name, { name, size });
    }
  }

  const files = Array.from(fileMap.values())
    .sort((a,b) => a.name.localeCompare(b.name));

  if(files.length === 0){
    listEl.innerHTML = `<div class="hint">No GIFs in /gifs</div>`;
    return;
  }

  for(const f of files){
    const card = document.createElement("div");
    card.className = "gif-card";
    card.innerHTML = `
      <div class="gif-top">
        <div class="gif-name" title="${escapeAttr(f.name)}">${escapeHtml(f.name)}</div>
        <div class="gif-meta">${escapeHtml(f.size)} bytes</div>
      </div>
      <div class="gif-actions">
        <button class="play" data-play="${escapeAttr(f.name)}">Play</button>
        <button class="del" data-del="${escapeAttr(f.name)}">Delete</button>
      </div>
    `;
    listEl.appendChild(card);
  }

  listEl.querySelectorAll("[data-play]").forEach(btn => {
    btn.onclick = async () => {
      const name = btn.getAttribute("data-play");
      log("TX: PLAY " + name);
      await writeText(`PLAY ${name}\n`);
      const resp = await readLine();
      log("RX: " + resp);
      if(resp !== "OK") alert("Play failed: " + resp);
    };
  });

  listEl.querySelectorAll("[data-del]").forEach(btn => {
    btn.onclick = async () => {
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

async function uploadReliable(){
  const file = fileInput.files?.[0];
  if(!file){
    setUpload("Pick a GIF first", "bad");
    return;
  }

  const safeName = file.name.replace(/[^\w.\-]/g, "_");
  const bytes = new Uint8Array(await file.arrayBuffer());

  setUpload(`Sending header… (${bytes.length} bytes)`);
  log(`TX: UPLOAD2 ${safeName} ${bytes.length}`);
  await writeText(`UPLOAD2 ${safeName} ${bytes.length}\n`);

  const ready = await readLine(15000);
  log("RX: " + ready);
  if(ready !== "READY"){
    setUpload("Device refused: " + ready, "bad");
    return;
  }

  await new Promise(r => setTimeout(r, 20));

  const CHUNK = 1024;
  let sent = 0;

  while(sent < bytes.length){
    const len = Math.min(CHUNK, bytes.length - sent);

    await writeText(`C ${len}\n`);
    await writer.write(bytes.slice(sent, sent + len));
    sent += len;

    const ack = await readLine(15000);
    log("RX: " + ack);
    if(!ack.startsWith("ACK ")){
      setUpload("Upload failed: " + ack, "bad");
      return;
    }

    setUpload(`Uploading… ${Math.floor((sent/bytes.length)*100)}%`);
  }

  const done = await readLine(15000);
  log("RX: " + done);

  if(done === "OK"){
    setUpload("Upload complete ✅", "good");
    await refreshList();
  } else {
    setUpload("Upload failed: " + done, "bad");
  }
}

// init
disableUI(true);
setStatus("Not connected", "warn");
setUpload("Uploads go to /gifs");

connectBtn.onclick = async () => {
  try { await connect(); }
  catch(e){
    console.error(e);
    log("ERROR: " + (e.message || e));
    setStatus("Connect failed", "bad");
  }
};

refreshBtn.onclick = async () => {
  try { await refreshList(); }
  catch(e){
    console.error(e);
    log("ERROR: " + (e.message || e));
    alert(e.message || String(e));
  }
};

uploadBtn.onclick = async () => {
  try { await uploadReliable(); }
  catch(e){
    console.error(e);
    log("ERROR: " + (e.message || e));
    setUpload(e.message || String(e), "bad");
  }
};
