// Over-air TX/RX verification: connect with the production interface, send one
// short KISS data frame, and watch the firmware's spontaneous stat reports
// (CMD_STAT_TX should increment on our transmission; CMD_STAT_RX on anything
// the radio hears — e.g. mesh announcements).

import { KISS } from "@reticulum/core/src/interfaces/rnode.js";
import { LogLevel, setLogLevel } from "@reticulum/core/src/utils/log.js";
import { RNodeSerialInterface } from "@reticulum/node/src/interfaces/rnode-serial.js";

const port = process.argv[2] || "/dev/cu.usbserial-0001";
setLogLevel(LogLevel.INFO);

const iface = new RNodeSerialInterface({
  name: "rnode-tx-test",
  port,
  frequency: 869475000,
  bandwidth: 125000,
  txPower: 7,
  spreadingFactor: 7,
  codingRate: 5,
  postOpenDelayMs: 0,
  detectTimeout: 20,
});

await iface.connect();
console.log(`online, rStatTx=${iface.rStatTx} rStatRx=${iface.rStatRx}`);

const txBefore = iface.rStatTx ?? 0;
const rxBefore = iface.rStatRx ?? 0;

// This firmware answers CMD_STAT_RX/TX only when queried (see
// microReticulum_Firmware RNode_Firmware.ino), so ask explicitly.
function queryStats() {
  iface._rawWrite(
    new Uint8Array([
      KISS.FEND,
      KISS.CMD_STAT_RX,
      0x00,
      KISS.FEND,
      KISS.FEND,
      KISS.CMD_STAT_TX,
      0x00,
      KISS.FEND,
    ]),
  );
}
const readCounter = () =>
  new Promise((r) => setTimeout(r, 500)).then(() => ({
    rx: iface.rStatRx,
    tx: iface.rStatTx,
  }));
queryStats();
const before = await readCounter();
console.log(`before: tx=${before.tx} rx=${before.rx}`);

// One short over-air transmission: KISS data frame with a few payload bytes.
const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
iface._rawWrite(
  new Uint8Array([KISS.FEND, KISS.CMD_DATA, ...payload, KISS.FEND]),
);
console.log("sent one data frame over the air");
await new Promise((r) => setTimeout(r, 2000));
queryStats();
const after = await readCounter();
console.log(`after:  tx=${after.tx} rx=${after.rx}`);
console.log(
  `airtime (short window): ${iface.rAirtimeShort}% — firmware updates this right after each TX queue flush`,
);
console.log(`last RSSI: ${iface.rCurrentRssi} dBm`);

console.log("\n=== result ===");
console.log(
  `TX counter incremented: ${after.tx > before.tx} (stat_tx is vestigial in this firmware — never incremented)`,
);
console.log(`RX counter incremented: ${after.rx > before.rx}`);
console.log(`last RSSI: ${iface.rCurrentRssi} dBm`);

await iface.disconnect();
console.log("clean disconnect");
setTimeout(() => process.exit(0), 500);
