// Full RNode bring-up test using the production public API:
// connect() runs detect → configure (freq/bw/txpower/sf/cr/radio-on) → validate.
// Then reads channel stats (proves the radio is actually on and sampling),
// and disconnects cleanly (powers the radio down).

import { LogLevel, setLogLevel } from "@reticulum/core/src/utils/log.js";
import { RNodeSerialInterface } from "@reticulum/node/src/interfaces/rnode-serial.js";

const port = process.argv[2] || "/dev/cu.usbserial-0001";
setLogLevel(LogLevel.DEBUG);

const iface = new RNodeSerialInterface({
  name: "rnode-test",
  port,
  // EU-868 default RNS channel
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

console.log("\n=== connected ===");
console.log(`fw:            ${iface.majVersion}.${iface.minVersion}`);
console.log(`platform:      0x${iface.platform?.toString(16)}`);
console.log(
  `rFrequency:    ${iface.rFrequency ? iface.rFrequency / 1e6 : "?"} MHz`,
);
console.log(`rBandwidth:    ${iface.rBandwidth} Hz`);
console.log(`rTxPower:      ${iface.rTxPower} dBm`);
console.log(`rSf:           ${iface.rSf}`);
console.log(`rCr:           ${iface.rCr}`);
console.log(`rState:        ${iface.rState} (1 = on)`);

// Let the radio sample the channel for a few seconds, then read stats
await new Promise((r) => setTimeout(r, 3000));
console.log("\n=== channel stats after 3 s (proves radio is on) ===");
console.log(`rStatRssi:     ${iface.rCurrentRssi} dBm`);
console.log(`rNoiseFloor:   ${iface.rNoiseFloor} dBm`);
console.log(`rStatRx:       ${iface.rStatRx}`);
console.log(`rStatTx:       ${iface.rStatTx}`);
console.log(`rAirtimeShort: ${iface.rAirtimeShort}%`);

console.log("\ndisconnecting (powers radio down)...");
await iface.disconnect();
console.log("disconnected, online =", iface.online);

// Small grace period, then exit
setTimeout(() => process.exit(iface.online ? 1 : 0), 500);
