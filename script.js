const connectBtn = document.getElementById("connectBtn");
const statusEl = document.getElementById("status");

const fileInput = document.getElementById("fileInput");
const uploadBtn = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");

const refreshBtn = document.getElementById("refreshBtn");
const listEl = document.getElementById("list");

let port, reader, writer;

function setStatus(msg, ok=false) {
  statusEl.textContent = msg;
  statusEl.style.color = ok ? "#00ff88" : "#ffaa00";
}

function logUpload(msg, ok=false) {
  uploadStatus.textContent = msg;
  uploadStatus.style.color = ok ? "#00ff88" : "#ffaa00";
}

async function readLine() {
  // Read until \n
  let line = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("Serial closed");
    line += new TextDecoder().decode(value);
    const idx = line.indexOf("\n");
    if (idx >= 0) {
      const out = line.slice(0, idx).replace("\r", "").trim();
      // keep any extra data after newline for next reads (simple approach: discard)
      return out;
    }
  }
}

async function writeText(s) {
  await writer.write(new TextEncoder().encode(s));
}

async function connect() {
  if (!("serial" in navigator)) {
    setStatus("WebSerial not supported (use Chrome/Edge)");
    return;
  }
  port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });

  writer = port.writable.getWriter();
  reader = port.readable.getReader();

  setStatus("Connected ✅", true);
  refreshBtn.disabled = false;
  uploadBtn.disabled = false;

  // Optional: read HELLO
  try {
    const line = await readLine();
    console.log("Device:", line);
  } catch {}
}

async function refreshList() {
  listEl.innerHTML = "";
  await writeText("LIST\n");

  const lines = [];
  while (true) {
    const line = await readLine();
    if (line === "BEGIN") continue;
    if (line === "END") break;
    lines.push(line);
  }

  const files = [];
  for (const l of lines) {
    // FILE name size
    if (l.startsWith("FILE ")) {
      const parts = l.split(" ");
      const name = parts[1];
      const size = parts[2] || "";
      files.push({ name, size });
    }
  }

  if (files.length === 0) {
    listEl.innerHTML = `<div class="small">No GIFs found on SD.</div>`;
    return;
  }

  for (const f of files) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <span class="name">${f.name}</span>
      <span class="small">${f.size} bytes</span>
      <button data-play="${f.name}">Play</button>
      <button data-del="${f.name}">Delete</button>
    `;
    listEl.appendChild(row);
  }

  listEl.querySelectorAll("button[data-play]").forEach(btn => {
    btn.onclick = async () => {
      const name = btn.getAttribute("data-play");
      await writeText(`PLAY ${name}\n`);
      const resp = await readLine();
      alert(resp === "OK" ? `Playing ${name}` : `Play failed: ${resp}`);
    };
  });

  listEl.querySelectorAll("button[data-del]").forEach(btn => {
    btn.onclick = async () => {
      const name = btn.getAttribute("data-del");
      await writeText(`DEL ${name}\n`);
      const resp = await readLine();
      if (resp === "OK") await refreshList();
      else alert(`Delete failed: ${resp}`);
    };
  });
}

async function uploadGif() {
  const file = fileInput.files?.[0];
  if (!file) return;

  // keep filename simple
  const name = file.name.replace(/[^\w.\-]/g, "_");
  const bytes = new Uint8Array(await file.arrayBuffer());

  logUpload(`Sending header... (${bytes.length} bytes)`);

  await writeText(`UPLOAD ${name} ${bytes.length}\n`);
  const ready = await readLine();
  if (ready !== "READY") {
    logUpload(`Device refused: ${ready}`);
    return;
  }

  logUpload("Uploading...");
  const chunk = 1024;
  for (let i = 0; i < bytes.length; i += chunk) {
    const part = bytes.slice(i, i + chunk);
    await writer.write(part);
  }

  const resp = await readLine();
  if (resp === "OK") {
    logUpload("Upload complete ✅", true);
    await refreshList();
  } else {
    logUpload(`Upload failed: ${resp}`);
  }
}

connectBtn.onclick = async () => {
  try { await connect(); }
  catch (e) { console.error(e); setStatus(`Connect failed: ${e.message || e}`); }
};

refreshBtn.onclick = async () => {
  try { await refreshList(); }
  catch (e) { console.error(e); alert(e.message || e); }
};

uploadBtn.onclick = async () => {
  try { await uploadGif(); }
  catch (e) { console.error(e); logUpload(`Upload error: ${e.message || e}`); }
};
