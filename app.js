const connectBtn = document.getElementById("connectBtn");
const statusEl   = document.getElementById("status");
const fileInput  = document.getElementById("fileInput");
const uploadBtn  = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const refreshBtn = document.getElementById("refreshBtn");
const listEl     = document.getElementById("list");

let port = null;
let reader = null;
let writer = null;

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

async function ensureConnected() {
  if (!("serial" in navigator)) {
    throw new Error("WebSerial not supported. Use Chrome or Edge.");
  }
  if (port && port.readable && port.writable) return;

  port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });

  writer = port.writable.getWriter();
  reader = port.readable.getReader();
}

async function writeText(s) {
  const data = new TextEncoder().encode(s);
  await writer.write(data);
}

// Simple line reader (works fine for our protocol)
async function readLine() {
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("Serial closed");
    buf += new TextDecoder().decode(value);
    const idx = buf.indexOf("\n");
    if (idx >= 0) {
      const line = buf.slice(0, idx).replace("\r", "").trim();
      return line;
    }
  }
}

async function connect() {
  await ensureConnected();
  setStatus("Connected ✅", "good");
  refreshBtn.disabled = false;
  uploadBtn.disabled = false;

  // Optional: read HELLO if firmware sends it
  try { console.log("Device:", await readLine()); } catch {}
}

async function refreshList() {
  listEl.innerHTML = "";
  await writeText("LIST\n");

  const files = [];
  while (true) {
    const line = await readLine();
    if (line === "BEGIN") continue;
    if (line === "END") break;
    if (line.startsWith("FILE ")) {
      const parts = line.split(" ");
      files.push({ name: parts[1], size: parts[2] || "" });
    }
  }

  if (files.length === 0) {
    listEl.innerHTML = `<div class="hint">No GIFs found on SD.</div>`;
    return;
  }

  for (const f of files) {
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <div>
        <div class="name">${f.name}</div>
        <div class="meta">${f.size} bytes</div>
      </div>
      <div class="actions">
        <button class="play" data-play="${f.name}">Play</button>
        <button class="del" data-del="${f.name}">Delete</button>
      </div>
    `;
    listEl.appendChild(item);
  }

  listEl.querySelectorAll("[data-play]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const name = btn.getAttribute("data-play");
      await writeText(`PLAY ${name}\n`);
      const resp = await readLine();
      alert(resp === "OK" ? `Playing ${name}` : `Play failed: ${resp}`);
    });
  });

  listEl.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const name = btn.getAttribute("data-del");
      await writeText(`DEL ${name}\n`);
      const resp = await readLine();
      if (resp === "OK") await refreshList();
      else alert(`Delete failed: ${resp}`);
    });
  });
}

async function uploadGif() {
  const file = fileInput.files?.[0];
  if (!file) return;

  const safeName = file.name.replace(/[^\w.\-]/g, "_");
  const bytes = new Uint8Array(await file.arrayBuffer());

  setUpload(`Sending header… (${bytes.length} bytes)`);
  await writeText(`UPLOAD ${safeName} ${bytes.length}\n`);

  const ready = await readLine();
  if (ready !== "READY") {
    setUpload(`Device refused: ${ready}`, "bad");
    return;
  }

  setUpload("Uploading…");
  const chunk = 1024;
  for (let i = 0; i < bytes.length; i += chunk) {
    await writer.write(bytes.slice(i, i + chunk));
  }

  const resp = await readLine();
  if (resp === "OK") {
    setUpload("Upload complete ✅", "good");
    await refreshList();
  } else {
    setUpload(`Upload failed: ${resp}`, "bad");
  }
}

connectBtn.addEventListener("click", async () => {
  try {
    setStatus("Connecting…");
    await connect();
  } catch (e) {
    console.error(e);
    setStatus(`Connect failed: ${e.message || e}`, "bad");
  }
});

refreshBtn.addEventListener("click", async () => {
  try { await refreshList(); }
  catch (e) { console.error(e); alert(e.message || e); }
});

uploadBtn.addEventListener("click", async () => {
  try { await uploadGif(); }
  catch (e) { console.error(e); setUpload(e.message || String(e), "bad"); }
});
