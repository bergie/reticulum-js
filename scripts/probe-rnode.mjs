/**
 * Live RNode probe — connects to a real device, runs the detect → configure →
 * validate handshake, and reports what the radio echoes back. Does NOT
 * transmit any data packets (just powers the receiver on).
 *
 * Run: node scripts/probe-rnode.mjs [devicePath] [frequencyHz]
 *
 * Defaults to /dev/tty.usbserial-0001 @ 868 MHz (EU). Pass a frequency that
 * matches your device's band; the radio reconfigures to whatever is sent.
 */

import fs from "node:fs";
import { LogLevel, setLogLevel } from "@reticulum/core/src/utils/log.js";
import { RNodeSerialInterface } from "../packages/node/src/interfaces/rnode-serial.js";

// DEBUG shows the radio's reports; EXTREME also shows raw KISS bytes.
setLogLevel(LogLevel.DEBUG);

// Synchronous, unbuffered output so nothing is lost if the run is killed.
const out = (m) => fs.writeSync(1, String(m) + "\n");

async function main() {
  const port = process.argv[2] || "/dev/tty.usbserial-0001";
  const frequency = Number(process.argv[3] || 868000000);

  const iface = new RNodeSerialInterface({
    port,
    baudRate: 115200,
    frequency,
    bandwidth: 125000,
    txPower: 17,
    spreadingFactor: 7,
    codingRate: 5,
    flowControl: false,
    detectTimeout: 4,
    validateTimeout: 4,
    postOpenDelayMs: 300,
    autoReconnect: false,
    name: "probe",
  });

  // Heartbeat so a blocked event loop is obvious during development.
  let tick = 0;
  const hb = setInterval(() => {
    out(
      `>>> heartbeat ${tick++} detected=${iface.detected} online=${iface.online} rFreq=${iface.rFrequency} rState=${iface.rState}`,
    );
  }, 500);

  out(`\n>>> Probing ${port} @ ${frequency} Hz ...`);
  try {
    await iface.connect();
    out(
      `\n>>> ONLINE ✅  fw ${iface.majVersion}.${iface.minVersion} ` +
        `platform=0x${(iface.platform ?? 0).toString(16)} ` +
        `mcu=0x${(iface.mcu ?? 0).toString(16)} ` +
        `bitrate=${Math.round(iface.bitrate / 100) / 10} kbps`,
    );
    out(
      `>>> Radio reports: freq=${iface.rFrequency} bw=${iface.rBandwidth} ` +
        `tx=${iface.rTxPower} sf=${iface.rSf} cr=${iface.rCr} state=${iface.rState}`,
    );
  } catch (e) {
    out(`\n>>> FAILED ❌  ${e.message}`);
    out(
      `>>> detected=${iface.detected} fw=${iface.majVersion}.${iface.minVersion} ` +
        `platform=0x${(iface.platform ?? 0).toString(16)} ` +
        `freq=${iface.rFrequency} state=${iface.rState}`,
    );
  } finally {
    clearInterval(hb);
    await iface.disconnect();
  }
}

main();
