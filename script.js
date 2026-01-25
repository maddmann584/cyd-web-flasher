const btn = document.getElementById("connectBtn");
const status = document.getElementById("status");

btn.onclick = async () => {
  if (!("serial" in navigator)) {
    status.textContent = "WebSerial not supported (use Chrome/Edge)";
    return;
  }

  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    status.textContent = "Connected to ESP32 ✅";
  } catch (e) {
    status.textContent = "Connection failed";
    console.error(e);
  }
};
