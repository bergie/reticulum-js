// Resilience test: connect the production RNodeSerialInterface, then force a
// real ESP32 board reset from outside (DTR/RTS pulse via a second pyserial
// fd), and verify the interface detects the loss, reconnects, and comes back
// online with the radio reconfigured.

import { LogLevel, setLogLevel } from "@reticulum/core/src/utils/log.js";
import { RNodeSerialInterface } from "@reticulum/node/src/interfaces/rnode-serial.js";

const port = process.argv[2] || "/dev/cu.usbserial-0001";
setLogLevel(LogLevel.DEBUG);

const iface = new RNodeSerialInterface({
  name: "rnode-reset-test",
  port,
  frequency: 869475000,
  bandwidth: 125000,
  txPower: 7,
  spreadingFactor: 7,
  codingRate: 5,
  postOpenDelayMs: 0,
  detectTimeout: 20,
});

console.log("connecting...");
await iface.connect();
console.log(`online: ${iface.online} (attempt 1)`);

let reconnects = 0;
const t0 = Date.now();
const disconnected = new Promise((resolve) => {
  iface.addEventListener("disconnected", () => {
    reconnects += 1;
    console.log(`disconnected at +${((Date.now() - t0) / 1000).toFixed(1)}s`);
  });
  iface.addEventListener("connected", () => {
    if (reconnects > 0) {
      console.log(
        `re-connected at +${((Date.now() - t0) / 1000).toFixed(1)}s, ` +
          `online: ${iface.online}`,
      );
      resolve();
    }
  });
});

console.log("forcing board reset from a second pyserial fd...");
const { spawnSync } = await import("node:child_process");
const r = spawnSync(
  "python3",
  [
    "-c",
    `
import serial, time
s = serial.Serial(${JSON.stringify(port)}, 115200, timeout=0.5)
s.dtr = False
s.rts = False
time.sleep(0.2)
s.dtr = True
s.rts = True
time.sleep(0.2)
s.close()
print("reset pulse sent")
`,
  ],
  { stdio: "inherit" },
);
if (r.status !== 0) throw new Error("python reset pulse failed");

console.log("waiting for auto-reconnect...");
const timeout = setTimeout(() => {
  console.error("FAIL: no reconnection within 30 s");
  process.exit(1);
}, 30000);

await disconnected;
clearTimeout(timeout);

await new Promise((r2) => setTimeout(r2, 1000));
console.log("\n=== after reconnect ===");
console.log(
  `rFrequency: ${iface.rFrequency ? iface.rFrequency / 1e6 : "?"} MHz`,
);
console.log(`rState:     ${iface.rState} (1 = on)`);
console.log(`rStatRssi:  ${iface.rCurrentRssi} dBm`);

await iface.disconnect();
console.log("clean disconnect, online =", iface.online);
setTimeout(() => process.exit(iface.online ? 1 : 0), 500);
