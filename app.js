const connectBtn   = document.getElementById("connectBtn");
const statusEl     = document.getElementById("status");
const fileInput    = document.getElementById("fileInput");
const uploadBtn    = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const gridEl       = document.getElementById("grid");
const errorBox     = document.getElementById("errorBox");

// QUICK TEMP: add a tiny log area
let logEl = document.getElementById("log");
if(!logEl){
  logEl = document.createElement("pre");
  logEl.id = "log";
  logEl.style.cssText = "margin-top:10px;padding:10px;border:1px solid #2a2a36;border-radius:12px;max-height:220px;overflow:auto;background:#0f0f14;color:#a5a5b4;font-size:12px;white-space:pre-wrap;";
  logEl.textContent = "WEB LOG:\n";
  errorBox.parentElement.appendChild(logEl);
}
function log(s){ logEl.textContent += s + "\n"; logEl.scrollTop = logEl.scrollHeight; }

let port=null, reader=null, writer=null;
let connected=false;

let rxText = "";
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

// ---- serial pumping ----
async function pump(timeoutMs=15000){
  const start = Date.now();
  while(true){
    if(Date.now()-start > timeoutMs) throw new Error("Timeout waiting for serial data");
    const {value, done} = await reader.read();
    if(done) throw new Error("Serial closed");
    if(value){
      rxText += dec.decode(value, {stream:true});
      return;
    }
  }
}

async function readLine(timeoutMs=15000){
  const start = Date.now();
  while(true){
    const idx = rxText.indexOf("\n");
    if(idx >= 0){
      const line = rxText.slice(0, idx).replace("\r","").trim();
      rxText = rxText.slice(idx+1);
      if(line) log("RX: " + line);
      return line;
    }
    if(Date.now()-start > timeoutMs) throw new Error("Timeout waiting for line");
    await pump(timeoutMs);
  }
}

async function writeText(s){
  log("TX: " + s.trim());
  await writer.write(enc.encode(s));
}

async function flushInput(ms=200){
  rxText = "";
  const t0 = Date.now();
  while(Date.now()-t0 < ms){
    try{ await pump(30); } catch {}
    await sleep(10);
  }
  rxText = "";
}

function isNoise(line){
  if(!line) return true;
  if(line === "HELLO") return true;
  if(line.startsWith("ets ") || line.startsWith("rst:") || line.startsWith("load:") ||
     line.startsWith("entry ") || line.startsWith("configsip:") || line.startsWith("mode:")) return true;
  return false;
}

async function readUntil(matchFn, timeoutMs=9000){
  const t0 = Date.now();
  while(true){
    if(Date.now()-t0 > timeoutMs) throw new Error("Timed out waiting for response");
    const line = await readLine(2500);
    if(isNoise(line)) continue;
    if(line.startsWith("ERR ")) throw new Error(line);
    if(matchFn(line)) return line;
  }
}

// ---- SERIAL QUEUE ----
let serialBusy = Promise.resolve();
function withSerialLock(fn){
  const run = async()=> await fn();
  const p = serialBusy.then(run, run);
  serialBusy = p.catch(()=>{});
  return p;
}

// ---- LIST ----
async function cmdLIST(){
  await flushInput(200);
  await writeText("LIST\n");
  await readUntil(l => l === "BEGIN", 12000);

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

async function refreshList(){
  clearError();
  gridEl.innerHTML = "";
  setUpload("Loading GIFs…");

  try{
    const files = await withSerialLock(async()=> await cmdLIST());

    if(!files.length){
      gridEl.innerHTML = `<div class="hint">No GIFs in /gifs</div>`;
      setUpload("No GIFs found.");
      return;
    }

    for(const f of files){
      const item = document.createElement("div");
      item.className = "cardItem";
      item.innerHTML = `
        <div class="thumb"><div class="ph">Preview later</div></div>
        <div class="meta">
          <div class="name" title="${escapeAttr(f.name)}">${escapeHtml(f.name)}</div>
          <div class="actions">
            <button class="btn play">Play</button>
            <button class="btn del">Delete</button>
          </div>
        </div>
      `;
      gridEl.appendChild(item);
    }

    setUpload(`Loaded ${files.length} file(s) ✅`, "good");
  } catch(e){
    showError("LIST failed:\n" + (e?.message || String(e)));
    setUpload("List failed", "bad");
  }
}

// ---- connect ----
async function connect(){
  clearError();
  log("---- CONNECT ----");

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
    rxText = "";

    connected = true;
    setStatus("Connected ✅", true);
    updateUploadEnabled();

    setUpload("Waiting for device…");
    await sleep(700);      // let ESP finish reset/SD mount noise
    await flushInput(250); // clear boot lines

    // now list
    await refreshList();
  } catch(e){
    connected=false;
    updateUploadEnabled();
    setStatus("Not connected");
    showError("Connect failed:\n" + (e?.message || String(e)));
  }
}

connectBtn.onclick = ()=>connect();
uploadBtn.onclick = ()=>{};
fileInput.onchange = ()=>updateUploadEnabled();

setStatus("Not connected");
setUpload("Connect to load your GIFs");
updateUploadEnabled();
