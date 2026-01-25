const connectBtn = document.getElementById("connectBtn");
const statusEl   = document.getElementById("status");
const fileInput  = document.getElementById("fileInput");
const uploadBtn  = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const refreshBtn = document.getElementById("refreshBtn");
const listEl     = document.getElementById("list");

let port=null, reader=null, writer=null;
const dec = new TextDecoder();
const enc = new TextEncoder();
let rxBuf = "";

// ---- UI helpers ----
function setStatus(msg, kind="warn") {
  statusEl.textContent = msg;
  statusEl.style.color = kind==="good" ? "#00ff88" : kind==="bad" ? "#ff4d4d" : "#ffaa00";
}
function setUpload(msg, kind="warn") {
  uploadStatus.textContent = msg;
  uploadStatus.style.color = kind==="good" ? "#00ff88" : kind==="bad" ? "#ff4d4d" : "#a8a8b3";
}
function disableUI(disabled) {
  refreshBtn.disabled = disabled;
  uploadBtn.disabled = disabled;
}

// ---- buffered line reader (critical) ----
async function readLine(timeoutMs=8000) {
  const start = Date.now();
  while (true) {
    const idx = rxBuf.indexOf("\n");
    if (idx >= 0) {
      const line = rxBuf.slice(0, idx).replace("\r","").trim();
      rxBuf = rxBuf.slice(idx+1);
      return line;
    }
    if (Date.now()-start > timeoutMs) throw new Error("Timeout waiting for ESP32");
    const {value, done} = await reader.read();
    if (done) throw new Error("Serial closed");
    rxBuf += dec.decode(value);
  }
}
async function writeText(s) {
  await writer.write(enc.encode(s));
}

// ---- SD browser state ----
let cwd = "/"; // current directory

function joinPath(base, name) {
  if (base === "/") return "/" + name;
  return base.replace(/\/+$/,"") + "/" + name;
}

function renderBrowser(items) {
  listEl.innerHTML = "";

  // Path header + Up button
  const header = document.createElement("div");
  header.className = "item";
  header.innerHTML = `
    <div>
      <div class="name">Path: ${escapeHtml(cwd)}</div>
      <div class="meta">Click folders to enter • Click a GIF to play</div>
    </div>
    <div class="actions">
      <button id="upBtn">Up</button>
    </div>
  `;
  listEl.appendChild(header);

  header.querySelector("#upBtn").onclick = async () => {
    if (cwd === "/") return;
    const parts = cwd.split("/").filter(Boolean);
    parts.pop();
    cwd = "/" + parts.join("/");
    if (cwd === "/") {} else cwd = cwd.replace(/\/+$/,"");
    await refreshDir();
  };

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "Folder is empty.";
    listEl.appendChild(empty);
    return;
  }

  for (const it of items) {
    const row = document.createElement("div");
    row.className = "item";

    if (it.type === "dir") {
      row.innerHTML = `
        <div>
          <div class="name">📁 ${escapeHtml(it.name)}</div>
          <div class="meta">Folder</div>
        </div>
        <div class="actions">
          <button data-enter="${escapeAttr(it.name)}">Open</button>
        </div>
      `;
      row.querySelector("[data-enter]").onclick = async () => {
        cwd = joinPath(cwd, it.name);
        await refreshDir();
      };
    } else {
      const lower = it.name.toLowerCase();
      const isGif = lower.endsWith(".gif");
      row.innerHTML = `
        <div>
          <div class="name">${isGif ? "🖼️" : "📄"} ${escapeHtml(it.name)}</div>
          <div class="meta">${escapeHtml(it.size)} bytes</div>
        </div>
        <div class="actions">
          ${isGif ? `<button class="play" data-play="${escapeAttr(it.name)}">Play</button>` : ""}
          <button class="del" data-del="${escapeAttr(it.name)}">Delete</button>
        </div>
      `;
      const playBtn = row.querySelector("[data-play]");
      if (playBtn) {
        playBtn.onclick = async () => {
          const full = joinPath(cwd, it.name);
          await writeText(`PLAY ${full}\n`);
          const resp = await readLine();
          if (resp !== "OK") alert("Play failed: " + resp);
        };
      }
      row.querySelector("[data-del]").onclick = async () => {
        const full = joinPath(cwd, it.name);
        if (!confirm(`Delete ${full}?`)) return;
        await writeText(`DEL ${full}\n`);
        const resp = await readLine();
        if (resp === "OK") await refreshDir();
        else alert("Delete failed: " + resp);
      };
    }

    listEl.appendChild(row);
  }
}

// ---- list current directory ----
async function refreshDir() {
  listEl.innerHTML = "";
  await writeText(`LISTDIR ${cwd}\n`);

  const items = [];
  while (true) {
    const line = await readLine(12000);
    if (line === "BEGIN") continue;
    if (line.startsWith("PATH ")) continue;
    if (line === "END") break;

    if (line.startsWith("DIR ")) {
      items.push({type:"dir", name: line.substring(4), size:""});
    } else if (line.startsWith("FILE ")) {
      // FILE name size
      const parts = line.split(" ");
      items.push({type:"file", name: parts[1], size: parts[2] || ""});
    }
  }

  // Folders first, then files
  items.sort((a,b) => (a.type===b.type ? a.name.localeCompare(b.name) : (a.type==="dir" ? -1 : 1)));
  renderBrowser(items);
}

// ---- connect ----
async function connect() {
  if (!("serial" in navigator)) throw new Error("WebSerial not supported. Use Chrome/Edge.");

  port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });

  writer = port.writable.getWriter();
  reader = port.readable.getReader();
  rxBuf = "";

  setStatus("Connected ✅", "good");
  disableUI(false);

  // optional hello
  try { await readLine(1500); } catch {}

  cwd = "/";
  await refreshDir();
}

// ---- reliable upload (UPLOAD2 + chunk ACK) ----
async function uploadGifReliable() {
  const file = fileInput.files?.[0];
  if (!file) { setUpload("Pick a GIF first", "bad"); return; }

  // Upload into current folder
  const safeName = file.name.replace(/[^\w.\-]/g, "_");
  const targetPath = joinPath(cwd, safeName);

  const bytes = new Uint8Array(await file.arrayBuffer());

  setUpload(`Header… ${bytes.length} bytes`);
  await writeText(`UPLOAD2 ${targetPath} ${bytes.length}\n`);

  const ready = await readLine(12000);
  if (ready !== "READY") { setUpload("Device refused: " + ready, "bad"); return; }

  setUpload("Uploading…");
  const CHUNK = 1024;

  let sent = 0;
  while (sent < bytes.length) {
    const len = Math.min(CHUNK, bytes.length - sent);

    // chunk header then raw bytes
    await writeText(`C ${len}\n`);
    await writer.write(bytes.slice(sent, sent + len));
    sent += len;

    const ack = await readLine(12000);
    if (!ack.startsWith("ACK ")) {
      setUpload("Upload failed: " + ack, "bad");
      return;
    }

    const pct = Math.floor((sent / bytes.length) * 100);
    setUpload(`Uploading… ${pct}%`);
  }

  const done = await readLine(12000);
  if (done === "OK") {
    setUpload("Upload complete ✅", "good");
    await refreshDir();
  } else {
    setUpload("Upload failed: " + done, "bad");
  }
}

// ---- escaping ----
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function escapeAttr(s){return String(s).replace(/["<>]/g,"_")}

// ---- wire UI ----
disableUI(true);
setStatus("Not connected", "warn");
setUpload("—");

connectBtn.onclick = async () => {
  try { setStatus("Connecting…"); await connect(); }
  catch (e) { console.error(e); setStatus("Connect failed: " + (e.message||e), "bad"); }
};

refreshBtn.onclick = async () => {
  try { await refreshDir(); }
  catch (e) { console.error(e); alert(e.message || String(e)); }
};

uploadBtn.onclick = async () => {
  try { await uploadGifReliable(); }
  catch (e) { console.error(e); setUpload(e.message || String(e), "bad"); }
};
