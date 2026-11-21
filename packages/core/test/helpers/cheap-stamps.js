/**
 * Pins cheap RNS 1.6.1 stamp emission targets for announce- and path
 * request-heavy tests.
 *
 * RNS 1.6.1 emits destination-announce and path-request stamps by default
 * (`Transport.STAMP_DESTINATIONS` / `STAMP_PATH_REQUESTS`). The production
 * targets (`DESTINATION_VALUE` 25.0, `PR_VALUE` 15.8) take minutes per
 * destination to mine on the WebCrypto engine — upstream mines them in
 * background worker processes, we mine inline — so test files that emit
 * announces or path requests import this helper for side effect. The
 * emission flags themselves stay at their production defaults.
 *
 * Per-test blocks may still override any of these knobs (save and restore).
 */
import { TransportCore } from "../../src/transport/transport.js";

TransportCore.DESTINATION_VALUE = 8.0;
TransportCore.DESTINATION_COST = 7.5;
TransportCore.PR_VALUE = 8.0;
