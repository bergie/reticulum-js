// Probe a real RNode over serial using the production RNodeSerialInterface
// transport + the base-class KISS read loop. Configures nothing; just detects
// and reports device + current radio state.

import { KISS } from "@reticulum/core/src/interfaces/rnode.js";
import { LogLevel, log, setLogLevel } from "@reticulum/core/src/utils/log.js";
import { RNodeSerialInterface } from "@reticulum/node/src/interfaces/rnode-serial.js";

const port = process.argv[2] || "/dev/cu.usbserial-0001";
setLogLevel(LogLevel.VERBOSE);

const iface = new RNodeSerialInterface({
  port,
  frequency: 869475000,
  bandwidth: 125000,
  txPower: 7,
  postOpenDelayMs: 0,
  detectTimeout: 20,
});

log(`probe`, `Opening transport on ${port}...`);
const transport = iface._openTransport();
// Dump raw bytes received from the device (hex), without locking the stream:
// tee() gives the read loop one branch and our logger the other.
const [forLoop, forDump] = transport.readable.tee();
iface._readableBytes = forLoop;
forDump
  .pipeTo(
    new WritableStream({
      write(chunk) {
        console.log(
          "RX:",
          Array.from(chunk)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" "),
        );
      },
    }),
  )
  .catch(() => {});
iface._transportWrite = transport.write;
iface._startReadLoop();

const done = Promise.withResolvers();

// Probe for the device; re-send every second like _configureDevice does
iface.detect();
const probeTimer = setInterval(() => iface.detect(), 1000);

// Poll for detect; when detected, query device info + current radio state
const pollDetect = setInterval(() => {
  if (!iface.detected) return;
  clearInterval(pollDetect);
  clearInterval(probeTimer);
  log("probe", "Device detected! Querying device info...");
  // Firmware version, platform, MCU, and current radio state
  iface._rawWrite(
    new Uint8Array([
      KISS.FEND,
      0x50,
      0x00,
      KISS.FEND, // fw version
      KISS.FEND,
      0x48,
      0x00,
      KISS.FEND, // platform
      KISS.FEND,
      0x49,
      0x00,
      KISS.FEND, // mcu
      KISS.FEND,
      0x06,
      0x00,
      KISS.FEND, // radio state
      KISS.FEND,
      0x01,
      0x00,
      KISS.FEND, // frequency
      KISS.FEND,
      0x02,
      0x00,
      KISS.FEND, // bandwidth
      KISS.FEND,
      0x03,
      0x00,
      KISS.FEND, // txpower
      KISS.FEND,
      0x04,
      0x00,
      KISS.FEND, // sf
      KISS.FEND,
      0x05,
      0x00,
      KISS.FEND, // cr
      KISS.FEND,
      0x27,
      0x00,
      KISS.FEND, // battery
    ]),
  );
  // Give the device a moment to answer everything, then report
  setTimeout(() => {
    const platformName =
      iface.platform === 0x80
        ? "ESP32"
        : iface.platform === 0x70
          ? "NRF52"
          : `0x${iface.platform?.toString(16)}`;
    console.log("\n=== RNode probe results ===");
    console.log(`detected:          ${iface.detected}`);
    console.log(`platform:          ${platformName}`);
    console.log(`mcu:               0x${(iface.mcu ?? 0).toString(16)}`);
    console.log(
      `fwVersion:         ${iface.fwVersionReceived ? `${iface.majVersion}.${iface.minVersion}` : "(none)"}`,
    );
    console.log(`display:           ${iface.display}`);
    console.log(`rState:            ${iface.rState} (1 = radio on)`);
    console.log(
      `rFrequency:        ${iface.rFrequency ? iface.rFrequency / 1e6 + " MHz" : "(none)"}`,
    );
    console.log(
      `rBandwidth:        ${iface.rBandwidth ? iface.rBandwidth + " Hz" : "(none)"}`,
    );
    console.log(`rTxPower:          ${iface.rTxPower} dBm`);
    console.log(`rSf:               ${iface.rSf}`);
    console.log(`rCr:               ${iface.rCr}`);
    console.log(`rStatRssi:         ${iface.rStatRssi}`);
    console.log(`rStatSnr:          ${iface.rStatSnr}`);
    console.log(
      `battery:           state=${iface.rBatteryState} percent=${iface.rBatteryPercent}`,
    );
    done.resolve();
  }, 2000);
}, 50);

const timeout = setTimeout(() => {
  console.log("\n=== RNode probe FAILED: detect timed out after 20 s ===");
  done.reject(new Error("detect timed out"));
}, 22000);

done.promise
  .catch(() => (process.exitCode = 1))
  .finally(() => {
    clearTimeout(timeout);
    clearInterval(probeTimer);
    try {
      iface._closeTransportSafely();
      iface._closeFd();
    } catch (_e) {}
  });
await done.promise;
