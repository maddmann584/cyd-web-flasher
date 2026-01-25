// app.js — CYD SD GIF Manager web UI (WebSerial)
// Supports: CONNECT, LIST, UPLOAD, PLAY, DEL
// Firmware protocol (115200):
//   HELLO
//   LIST -> BEGIN, FILE name size, ..., END
//   UPLOAD name size -> READY -> (raw bytes) -> OK
//   PLAY name -> OK
//   DEL name  -> OK

const connectBtn = document.getElementById("connectBtn");
const statusEl = document.getElementById("status");
const fileInput = document.getElementById("fileInput");
const uploadBtn = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const refreshBtn = document.getElementById("refreshBtn");
const listEl = document.getElementById("list");

let port = null;
let reader = null;
let writer = null;

// Persistent receive buffer (FIXES dropped lines)
let rxBuf = "";
let textDecoder = new TextDecoder();
let textEncoder = new TextEncoder();

function setStatus(msg, kind = "warn") {
  statusEl.textContent = msg;
  statusEl.style.color =
    kind === "good" ? "#00ff88" :
    kind === "bad"  ? "#ff4d4d" :
                      "#ffaa00";
}

function setUpload(msg, kind = "warn") {
  uploadStatus.textContent = msg;
  uploadStatus.style.color =
    kind === "good" ? "#00ff88" :
    kind === "bad"  ? "#ff4d4d" :
                      "#a8a8b3";
}

function disableUI(disabled) {
  refreshBtn.disabled = disabled;
  uploadBtn.disabled = disabled;
}

async function writeText(line) {
  if (!writer) throw new Error("Not connected");
  await writer.write(textEncoder.encode(line));
}

async function readLine(timeoutMs = 4000) {
  const start = Date.now();

  while (true) {
    // Do we already have a full line buffered?
    const idx = rxBuf.indexOf("\n");
    if (idx >= 0) {
      const line = rxBuf.slice(0, idx).replace("\r", "").trim();
      rxBuf = rxBuf.slice(idx + 1);
      return line;
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for device response");
    }

    const { value, done } = await reader.read();
    if (done) throw new Error("Serial closed");
    rxBuf += textDecoder.decode(value);
  }
}

async function connect() {
  if (!("serial" in navigator)) {
    throw new Error("WebSerial not supported. Use Chrome or Edge.");
  }

  // If already connected, do nothing
  if (port && port.readable && port.writable) return;

  port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });

  writer = port.writable.getWriter();
  reader = port.readable.getReader();
  rxBuf = "";

  // Try to read HELLO (non-fatal if it isn't there yet)
  try {
    const hello = await readLine(1200);
    console.log("Device:", hello);
  } catch (_) {}

  setStatus("Connected ✅", "good");
  disableUI(false);
}

async function disconnect() {
  try { if (reader) { await reader.cancel(); reader.releaseLock(); } } catch {}
  try { if (writer) { writer.releaseLock(); } } catch {}
  try { if (port) { await port.close(); } } catch {}
  port = reader = writer = null;
  rxBuf = "";
  setStatus("Not connected", "warn");
  disableUI(true);
  listEl.innerHTML = "";
  setUpload("—");
}

function renderList(files) {
  listEl.innerHTML = "";

  if (!files.length) {
    listEl.innerHTML = `<div class="hint">No GIFs found on SD.</div>`;
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
      try {
        await writeText(`PLAY ${name}\n`);
        const resp = await readLine();
        alert(resp === "OK" ? `Playing ${name}` : `Play failed: ${resp}`);
      } catch (e) {
        console.error(e);
        alert(e.message || String(e));
      }
    });
  });

  listEl.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const name = btn.getAttribute("data-del");
      if (!confirm(`Delete ${name}?`)) return;
      try {
        await writeText(`DEL ${name}\n`);
        const resp = await readLine();
        if (resp === "OK") {
          await refreshList();
        } else {
          alert(`Delete failed: ${resp}`);
        }
      } catch (e) {
        console.error(e);
        alert(e.message || String(e));
      }
    });
  });
}

async function refreshList() {
  if (!writer || !reader) throw new Error("Not connected");

  await writeText("LIST\n");

  // Read until END
  const files = [];
  while (true) {
    const line = await readLine(6000);
    if (line === "BEGIN") continue;
    if (line === "END") break;

    if (line.startsWith("FILE ")) {
      // FILE name size
      const parts = line.split(" ");
      const name = parts[1] || "";
      const size = parts[2] || "";
      if (name) files.push({ name, size });
    }
  }

  renderList(files);
}

async function uploadGif() {
  const file = fileInput.files?.[0];
  if (!file) {
    setUpload("Pick a GIF first", "bad");
    return;
  }
  if (!writer || !reader) throw new Error("Not connected");

  const safeName = file.name.replace(/[^\w.\-]/g, "_");
  const bytes = new Uint8Array(await file.arrayBuffer());

  setUpload(`Sending header… (${bytes.length} bytes)`);

  await writeText(`UPLOAD ${safeName} ${bytes.length}\n`);

  const ready = await readLine(8000);
  if (ready !== "READY") {
    setUpload(`Device refused: ${ready}`, "bad");
    return;
  }

  setUpload("Uploading…");

  const CHUNK = 1024;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    await writer.write(bytes.slice(i, i + CHUNK));
  }

  const resp = await readLine(15000);
  if (resp === "OK") {
    setUpload("Upload complete ✅", "good");
    await refreshList();
  } else {
    setUpload(`Upload failed: ${resp}`, "bad");
  }
}

// Basic escaping for safe UI rendering
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function escapeAttr(s) {
  // Keep it simple: encode quotes & angle brackets
  return String(s).replace(/["<>]/g, "_");
}

// Wire up UI
disableUI(true);
setStatus("Not connected", "warn");

connectBtn.addEventListener("click", async () => {
  try {
    setStatus("Connecting…");
    await connect();
    setStatus("Connected ✅", "good");
  } catch (e) {
    console.error(e);
    setStatus(`Connect failed: ${e.message || e}`, "bad");
    // try to fully reset state
    await disconnect();
  }
});

refreshBtn.addEventListener("click", async () => {
  try {
    await refreshList();
  } catch (e) {
    console.error(e);
    alert(e.message || String(e));
  }
});

uploadBtn.addEventListener("click", async () => {
  try {
    await uploadGif();
  } catch (e) {
    console.error(e);
    setUpload(e.message || String(e), "bad");
  }
});
