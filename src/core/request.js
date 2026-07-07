/**
 * @file request.js
 * @description Request/Response serialization for rngit
 */

import { Identity } from "./identity.js";
import { ContextType, Packet } from "./packet.js";

/**
 * Handles serialization and deserialization of RNS Requests and Responses.
 */
export class RequestManager {
  /**
   * @param {import("../transport/link.js").Link} link - The link to use for requests.
   */
  constructor(link) {
    this.link = link;
    /** @type {Map<string, {resolve: Function, reject: Function}>} */
    this.pendingRequests = new Map();

    // Listen for incoming packets on the link to handle responses
    this.link.addEventListener("packet", (event) => {
      const packet = /** @type {CustomEvent} */ (event).detail;
      this._handleResponse(packet);
    });
  }

  /**
   * Handles an incoming response packet.
   * @param {Packet} packet
   * @private
   */
  _handleResponse(packet) {
    // Response payload: Bytes 0-15: Request ID, Bytes 16+: Response Data
    if (packet.payload.length < 16) {
      return;
    }

    const requestId = packet.payload.slice(0, 16);
    const responseData = packet.payload.slice(16);
    const requestIdKey = Array.from(requestId)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const pending = this.pendingRequests.get(requestIdKey);
    if (pending) {
      this.pendingRequests.delete(requestIdKey);
      pending.resolve(responseData);
    }
  }

  /**
   * Sends a request over the link and waits for the response.
   * @param {string} path - The endpoint path.
   * @param {Uint8Array} appData - The query payload.
   * @returns {Promise<Uint8Array>} The response data.
   */
  async sendRequest(path, appData = new Uint8Array(0)) {
    // 1. Generate a unique 16-byte Request ID
    const requestId = crypto.getRandomValues(new Uint8Array(16));
    const requestIdKey = Array.from(requestId)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // 2. Generate the 16-byte Path Hash
    const encoder = new TextEncoder();
    const pathHash = await Identity.truncatedHash(encoder.encode(path));

    // 3. Allocate and assemble payload
    const payload = new Uint8Array(32 + appData.length);
    payload.set(requestId, 0);
    payload.set(pathHash, 16);
    payload.set(appData, 32);

    // 4. Track the request
    const responsePromise = new Promise((resolve, reject) => {
      this.pendingRequests.set(requestIdKey, { resolve, reject });
    });

    // 5. Send via Link
    // We create a Packet with contextFlag = true and contextByte = CONTEXT_REQUEST.
    // The Link will encrypt the payload.
    const packet = new Packet({
      headerType: 0, // HEADER_1
      hops: 0,
      transportType: 0, // BROADCAST
      destinationType: 3, // LINK
      packetType: 0, // DATA
      contextFlag: true,
      contextByte: ContextType.REQUEST,
      destinationHash: this.link.linkId,
      payload: payload,
    });

    try {
      await this.link.send(packet);
    } catch (e) {
      this.pendingRequests.delete(requestIdKey);
      throw e;
    }

    return responsePromise;
  }
}
