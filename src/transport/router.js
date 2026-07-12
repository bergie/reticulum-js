import { toHex } from "../utils/encoding.js";
import { log, LogLevel } from "../utils/log.js";

/**
 * @typedef {Object} Route
 * @property {import("../interfaces/base.js").Interface} interface
 * @property {number} hops
 * @property {number} timestamp
 */

export class RoutingTable {
  constructor() {
    // Maps Destination Hash (Hex String) to RouteEntry
    this.routes = new Map();
  }

  /**
   * Called whenever an Announce packet is received on ANY interface.
   * @param {Uint8Array} destinationHash
   * @param {import("../interfaces/base.js").Interface} viaInterface
   * @param {number} hops
   */
  addOrUpdateRoute(destinationHash, viaInterface, hops) {
    const destKey = destinationHash;
    const existingRoute = this.routes.get(destKey);

    // Reticulum routing logic: Always prefer the shortest path.
    // If the path length is equal, prefer the newest announcement.
    if (!existingRoute || hops <= existingRoute.hops) {
      this.routes.set(destKey, {
        interface: viaInterface,
        hops: hops,
        timestamp: Date.now(),
      });
      return true; // Route was updated
    }
    return false; // Route ignored (longer path)
  }

  /**
   * @param {Uint8Array} destinationHash
   * @returns {Route}
   */
  getRoute(destinationHash) {
    const destKey = toHex(destinationHash);
    return this.routes.get(destKey);
  }

  /**
   * Called when a physical interface disconnects.
   * @param {import("../interfaces/base.js").Interface} failedInterface
   */
  dropInterface(failedInterface) {
    let droppedCount = 0;
    for (const [destKey, route] of this.routes.entries()) {
      if (route.interface === failedInterface) {
        this.routes.delete(destKey);
        droppedCount++;
      }
    }
    log("Router", `Dropped ${droppedCount} routes due to interface failure.`);
  }
}
