// app.js (debug-first version)
// Shows exactly what the ESP32 returns so we can’t “silently fail”.

const connectBtn = document.getElementById("connectBtn");
const statusEl   = document.getElementById("status");
const fileInput  = document.getElementById("fileInput");
const uploadBtn  = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const refreshBtn = document.getElementById("refreshBtn");
const listEl     = document.getElementById("list");

// ---- UI helpers ----
function setStatus(msg, kind="warn") {
  statusEl.textContent = msg;
  statusEl.style.color =
    kind === "good" ? "#00ff88" :
    kind === "bad"  ? "#ff4d4d" :
                      "#ffaa00";
}
function setUpload(msg, kind="warn") {
  uploadStatus.textContent = msg;
  uploadStatus.style.color =
    kind === "good" ? "#00ff88" :
    kind === "bad"  ? "#ff4d4d" :
                      "#a8a8b3";
}

// Create an on-page debug box (so you don’t need DevTools)
const dbg = document.createElement("pre");
dbg.style.whiteSpace = "pre-wrap";
dbg.style.textAlign = "left";
dbg.style.background = "#101014";
dbg.style.border = "1px solid #2a2a33";
dbg.style.borderRadius = "12px";
dbg.style.padding = "10px";
dbg.style.marginTop = "12px";
dbg.style.maxHeight = "220px";
dbg.style.overflow = "auto";
dbg.textContent = "Debug log:\n";
listEl.parentElement.appendChild(dbg);

function log(msg) {
  console.log(msg);
  dbg.textContent += msg + "\n";
  dbg.scrollTop = dbg.scrollHeight;
}

function disableUI(disabled) {
  refreshBtn.disabled = disabled;
  uploadBtn.disabled = disabled;
}

// ---- WebSerial state ----
let port = null;
let reader = null;
let writer = null;

const dec = new TextDecoder();
const enc = new TextEncoder();
let rxBuf = "";

// Buffered line reader (CRITICAL FIX)
async function readLine(timeoutMs = 6000) {
  const start = Date.now();
  while (true) {
    const idx = rxBuf.indexOf("\n");
    if (idx >= 0) {
      const line = rxBuf.slice(0, idx).replace("\r", "").trim();
      rxBuf = rxBuf.slice(idx + 1);
      return line;
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error("Timeout waiting for a line from ESP32");
    }

    const { value, done } = await reader.read();
    if (done) throw new Error("Serial closed");
    rxBuf += dec.decode(value);
  }
}

async function writeText(s) {
  await writer.write(enc.encode(s));
}

async function connect() {
  if (!("serial" in navigator)) {
    throw new Error("WebSerial not supported. Use Chrome or Edge.");
  }

  log("Requesting port...");
  port = await navigator.serial.requestPort();

  log("Opening @115200...");
  await port.open({ baudRate: 115200 });

  writer = port.writable.getWriter();
  reader = port.readable.getReader();
  rxBuf = "";

  setStatus("Connected ✅", "good");
  disableUI(false);
  log("Connected.");

  // Try to read HELLO (optional)
  try {
    const hello = await readLine(1500);
    log("RX: " + hello);
  } catch {
    log("No HELLO line (not fatal).");
  }
}

function renderFiles(files) {
  listEl.innerHTML = "";

  if (!files.length) {
    listEl.innerHTML = `<div class="hint">No GIFs found (or LIST parsing failed).</div>`;
    return;
  }

  for (const f of files) {
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <div>
        <div class="name">${escapeHtml(f.name)}</div>
        <div class="meta">${escapeHtml(f.size)} bytes</div>
      </div>
      <div class="actions">
        <button class="play" data-play="${escapeAttr(f.name)}">Play</button>
        <button class="del" data-del="${escapeAttr(f.name)}">Delete</button>
      </div>
    `;
    listEl.appendChild(item);
  }

  listEl.querySelectorAll("[data-play]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const name = btn.getAttribute("data-play");
      log("TX: PLAY " + name);
      await writeText(`PLAY ${name}\n`);
      const resp = await readLine();
      log("RX: " + resp);
      alert(resp === "OK" ? `Playing ${name}` : `Play failed: ${resp}`);
    });
  });

  listEl.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const name = btn.getAttribute("data-del");
      if (!confirm(`Delete ${name}?`)) return;
      log("TX: DEL " + name);
      await writeText(`DEL ${name}\n`);
      const resp = await readLine();
      log("RX: " + resp);
      if (resp === "OK") await refreshList();
      else alert(`Delete failed: ${resp}`);
    });
  });
}

async function refreshList() {
  if (!writer || !reader) throw new Error("Not connected");

  log("TX: LIST");
  await writeText("LIST\n");

  const files = [];
  let sawBegin = false;

  while (true) {
    const line = await readLine(8000);
    log("RX: " + line);

    if (line === "BEGIN") { sawBegin = true; continue; }
    if (line === "END") break;

    if (line.startsWith("FILE ")) {
      // FILE <name> <size>
      const parts = line.split(" ");
      const name = parts[1] || "";
      const size = parts[2] || "";
      if (name) files.push({ name, size });
    }
  }

  if (!sawBegin) log("WARN: did not see BEGIN (protocol mismatch?)");

  log(`Parsed ${files.length} file(s). Rendering...`);
  renderFiles(files);
}

async function uploadGif() {
  const file = fileInput.files?.[0];
  if (!file) { setUpload("Pick a GIF first", "bad"); return; }
  if (!writer || !reader) throw new Error("Not connected");

  const safeName = file.name.replace(/[^\w.\-]/g, "_");
  const bytes = new Uint8Array(await file.arrayBuffer());

  setUpload(`Sending header… (${bytes.length} bytes)`);
  log(`TX: UPLOAD ${safeName} ${bytes.length}`);
  await writeText(`UPLOAD ${safeName} ${bytes.length}\n`);

  const ready = await readLine(10000);
  log("RX: " + ready);
  if (ready !== "READY") {
    setUpload(`Device refused: ${ready}`, "bad");
    return;
  }

  setUpload("Uploading…");
  const CHUNK = 1024;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    await writer.write(bytes.slice(i, i + CHUNK));
  }

  const resp = await readLine(20000);
  log("RX: " + resp);

  if (resp === "OK") {
    setUpload("Upload complete ✅", "good");
    await refreshList();
  } else {
    setUpload(`Upload failed: ${resp}`, "bad");
  }
}

// Safe escaping
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function escapeAttr(s) {
  return String(s).replace(/["<>]/g, "_");
}

// ---- Wire up ----
disableUI(true);
setStatus("Not connected", "warn");
setUpload("—");

connectBtn.addEventListener("click", async () => {
  try {
    setStatus("Connecting…");
    await connect();
  } catch (e) {
    console.error(e);
    log("ERROR: " + (e.message || e));
    setStatus("Connect failed", "bad");
    disableUI(true);
  }
});

refreshBtn.addEventListener("click", async () => {
  try {
    await refreshList();
  } catch (e) {
    console.error(e);
    log("ERROR: " + (e.message || e));
    alert(e.message || String(e));
  }
});

uploadBtn.addEventListener("click", async () => {
  try {
    await uploadGif();
  } catch (e) {
    console.error(e);
    log("ERROR: " + (e.message || e));
    setUpload(e.message || String(e), "bad");
  }
});
