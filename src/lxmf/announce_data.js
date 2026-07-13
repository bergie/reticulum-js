/**
 * @file announce_data.js
 * @description `lxmf.delivery` announce `app_data` msgpack format (SPEC §4.3).
 *
 * Current upstream `LXMF/LXMRouter.py::get_announce_app_data` produces a
 * 3-element msgpack array:
 *
 *   [ display_name(bin8), stamp_cost(int|nil), [SF_COMPRESSION] ]
 *
 * Receivers MUST also tolerate the legacy 2-element, 1-element, and raw
 * UTF-8 string shapes (`LXMF/LXMF.py::display_name_from_app_data`).
 *
 * Canonical wire bytes for `display_name = "Reticulum5"`, `stamp_cost = nil`:
 *
 *   93                                 # fixarray, 3 elements
 *   c4 0a 52 65 74 69 63 75 6c 75 6d 35 # bin8 len=10, "Reticulum5"
 *   c0                                 # nil (stamp_cost)
 *   91 00                              # fixarray(1): [SF_COMPRESSION]
 */

import { MicroMsgPack } from "../utils/msgpack.js";
import { SF_COMPRESSION } from "./constants.js";

/**
 * Builds the msgpack `app_data` blob for an `lxmf.delivery` announce.
 *
 * The display name is encoded as msgpack `bin` (0xc4), NOT `str`, matching
 * upstream (§4.3 / §9.3). A `str`-encoded name breaks peer-name display in
 * Sideband/Nomadnet/MeshChat because those clients read element 0 as bytes.
 *
 * @param {string} displayName - Human-readable node name.
 * @param {number|null} [stampCost=null] - Active stamp cost (upstream emits
 *   `nil` unless `1 ≤ N ≤ 254`); `null` signals stamping is disabled.
 * @param {number[]} [supportedFunctions] - Capability flags; defaults to
 *   `[SF_COMPRESSION]`.
 * @returns {Uint8Array}
 */
export function buildAnnounceAppData(
  displayName,
  stampCost = null,
  supportedFunctions = [SF_COMPRESSION],
) {
  const nameBin = new TextEncoder().encode(displayName);
  return MicroMsgPack.encode([nameBin, stampCost, supportedFunctions]);
}

/**
 * Parsed `lxmf.delivery` announce `app_data`.
 *
 * @typedef {Object} AnnounceAppData
 * @property {string} displayName
 * @property {number|null} stampCost
 * @property {number[]} supportedFunctions
 */

/**
 * Parses an `lxmf.delivery` announce `app_data` blob, tolerating all four
 * legacy shapes documented in §4.3:
 *   - 3-element array  `[name, stamp_cost, supported_functions]`
 *   - 2-element array  `[name, stamp_cost]`
 *   - 1-element array  `[name]`
 *   - raw UTF-8 string ("original announce format")
 *
 * A missing capability list means compression support defaults to true for
 * backward compatibility (§4.3).
 *
 * @param {Uint8Array|null|undefined} appData
 * @returns {AnnounceAppData|null} `null` when appData is empty/absent or the
 *   bytes are neither valid msgpack nor decodable UTF-8.
 */
export function parseAnnounceAppData(appData) {
  if (!appData || appData.length === 0) return null;

  let msgpackValue;
  let msgpackOk = true;
  try {
    msgpackValue = MicroMsgPack.decode(appData);
  } catch {
    msgpackOk = false;
  }

  if (msgpackOk) {
    const coerced = coerceAnnounceAppData(msgpackValue);
    if (coerced) return coerced;
  }

  // Fallback: the "original announce format" (LXMF/LXMF.py:138-139) — raw
  // UTF-8 bytes that either failed msgpack decoding or decoded to a non-name
  // scalar. A bare display name like "Grace" starts with 0x47, which msgpack
  // silently reads as a fixint (71), so we cannot rely on a thrown error and
  // must re-decode the original bytes as text.
  try {
    return {
      displayName: new TextDecoder().decode(appData),
      stampCost: null,
      supportedFunctions: [SF_COMPRESSION],
    };
  } catch {
    return null;
  }
}

/**
 * Normalises a decoded msgpack value into an {@link AnnounceAppData}.
 *
 * @param {unknown} decoded
 * @returns {AnnounceAppData|null}
 * @private
 */
function coerceAnnounceAppData(decoded) {
  if (Array.isArray(decoded)) {
    const displayName = decodeName(decoded[0]);
    const stampCost = decodeStampCost(decoded[1]);
    // §4.3: a missing capability list (1- or 2-element array) means
    // compression support defaults to true for backward compatibility.
    const supportedFunctions = Array.isArray(decoded[2])
      ? /** @type {number[]} */ (decoded[2])
      : [SF_COMPRESSION];
    return { displayName, stampCost, supportedFunctions };
  }
  if (typeof decoded === "string") {
    return {
      displayName: decoded,
      stampCost: null,
      supportedFunctions: [SF_COMPRESSION],
    };
  }
  if (decoded instanceof Uint8Array) {
    return {
      displayName: new TextDecoder().decode(decoded),
      stampCost: null,
      supportedFunctions: [SF_COMPRESSION],
    };
  }
  return null;
}

/**
 * Decodes the display-name element, which may be msgpack `bin` (Uint8Array)
 * or `str` (string) depending on the sender.
 *
 * @param {unknown} value
 * @returns {string}
 * @private
 */
function decodeName(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return "";
}

/**
 * Decodes the stamp-cost element. Upstream only emits a non-`nil` value for
 * `1 ≤ N ≤ 254`, but the parser is permissive (§4.3): any integer is returned
 * as-is, everything else maps to `null` (stamping disabled).
 *
 * @param {unknown} value
 * @returns {number|null}
 * @private
 */
function decodeStampCost(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return /** @type {number} */ (value);
  }
  return null;
}
