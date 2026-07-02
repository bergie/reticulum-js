/**
 * @file destination.js
 * @description Routing targets (EventTargets)
 */

import { Identity } from './identity.js';

/**
 * Types of destinations.
 * @enum {number}
 */
export const DestinationType = {
    SINGLE: 0x00,
    GROUP: 0x01,
    PLAIN: 0x02,
    LINK: 0x03
};

/**
 * Helper functions for encoding/decoding buffers.
 */
function bufToHex(buf) {
    return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex) {
    const buf = new Uint8Array(hex.length / 2);
    for (let i = 0; i < buf.length; i++) {
        buf[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return buf;
}

/**
 * Represents a Reticulum destination.
 */
export class Destination extends EventTarget {
    /**
     * Storage for known destinations.
     * @type {Map<string, Array>}
     */
    static knownDestinations = new Map();

    /**
     * @param {string} name - The application name.
     * @param {DestinationType} type - The destination type.
     * @param {Identity|null} identity - The identity associated with this destination.
     */
    constructor(name, type, identity = null) {
        super();
        this.name = name;
        this.type = type;
        this.identity = identity;
        this.destinationHash = null;
        this.nameHash = null;
    }

    /**
     * Static factory for creating a destination.
     * @param {string} name
     * @param {DestinationType} type
     * @param {Identity|null} identity
     * @returns {Promise<Destination>}
     */
    static async create(name, type, identity = null) {
        const dest = new Destination(name, type, identity);
        await dest._computeHashes();
        return dest;
    }

    /**
     * Computes the nameHash and destinationHash.
     * @private
     */
    async _computeHashes() {
        const encoder = new TextEncoder();
        const nameBytes = encoder.encode(this.name);
        
        // nameHash = SHA256(full_app_name_string)[:10]
        const nameHashBuffer = await crypto.subtle.digest("SHA-256", nameBytes);
        this.nameHash = new Uint8Array(nameHashBuffer.slice(0, 10));

        if (this.type === DestinationType.SINGLE && this.identity) {
            // destHash = SHA256(nameHash || identityHash)[:16]
            const combined = new Uint8Array(this.nameHash.length + this.identity.identityHash.length);
            combined.set(this.nameHash, 0);
            combined.set(this.identity.identityHash, this.nameHash.length);

            const destHashBuffer = await crypto.subtle.digest("SHA-256", combined);
            this.destinationHash = new Uint8Array(destHashBuffer.slice(0, 16));
        } else if (this.type === DestinationType.GROUP && this.identity) {
             // Same as SINGLE for GROUP
            const combined = new Uint8Array(this.nameHash.length + this.identity.identityHash.length);
            combined.set(this.nameHash, 0);
            combined.set(this.identity.identityHash, this.nameHash.length);

            const destHashBuffer = await crypto.subtle.digest("SHA-256", combined);
            this.destinationHash = new Uint8Array(destHashBuffer.slice(0, 16));
        } else if (this.type === DestinationType.PLAIN) {
            // destHash = SHA256(nameHash)[:16]
            const destHashBuffer = await crypto.subtle.digest("SHA-256", this.nameHash);
            this.destinationHash = new Uint8Array(destHashBuffer.slice(0, 16));
        } else {
            this.destinationHash = null;
        }
    }

    /**
     * Creates an IN destination.
     * @param {string} name
     * @param {DestinationType} type
     * @param {Identity|null} identity
     * @returns {Promise<Destination>}
     */
    static async IN(name, type, identity = null) {
        return await this.create(name, type, identity);
    }

    /**
     * Creates an OUT destination.
     * @param {string} name
     * @param {DestinationType} type
     * @param {Identity|null} identity
     * @returns {Promise<Destination>}
     */
    static async OUT(name, type, identity = null) {
        return await this.create(name, type, identity);
    }

    /**
     * Creates a SINGLE destination.
     * @param {string} name
     * @param {Identity|null} identity
     * @returns {Promise<Destination>}
     */
    static async SINGLE(name, identity = null) {
        return await this.create(name, DestinationType.SINGLE, identity);
    }

    /**
     * Creates a GROUP destination.
     * @param {string} name
     * @param {Identity|null} identity
     * @returns {Promise<Destination>}
     */
    static async GROUP(name, identity = null) {
        return await this.create(name, DestinationType.GROUP, identity);
    }

    /**
     * Creates a PLAIN destination.
     * @param {string} name
     * @returns {Promise<Destination>}
     */
    static async PLAIN(name) {
        return await this.create(name, DestinationType.PLAIN, null);
    }

    /**
     * Remember a destination.
     * @param {Uint8Array} packet_hash
     * @param {Uint8Array} destination_hash
     * @param {Uint8Array} public_key
     * @param {any} app_data
     */
    static async remember(packet_hash, destination_hash, public_key, app_data = null) {
        const key = bufToHex(destination_hash);
        if (Destination.knownDestinations.has(key)) {
            const entry = Destination.knownDestinations.get(key);
            entry[0] = Date.now() / 1000; // time.time() in seconds
            entry[1] = packet_hash;
            entry[2] = public_key;
            entry[3] = app_data;
        } else {
            Destination.knownDestinations.set(key, [Date.now() / 1000, packet_hash, public_key, app_data, 0]);
        }
    }

    /**
     * Recall an identity for a destination or identity hash.
     * @param {Uint8Array} target_hash
     * @param {boolean} from_identity_hash
     * @returns {Promise<Identity|null>}
     */
    static async recall(target_hash, from_identity_hash = false) {
        if (from_identity_hash) {
            for (const [key, entry] of Destination.knownDestinations.entries()) {
                const public_key = entry[2];
                const identity = await Identity.fromPublicKey(public_key);
                const identity_hash = await Identity.truncatedHash(identity.publicKey);
                
                if (bufToHex(target_hash) === bufToHex(identity_hash)) {
                    identity.app_data = entry[3];
                    return identity;
                }
            }
            return null;
        } else {
            const key = bufToHex(target_hash);
            if (Destination.knownDestinations.has(key)) {
                const entry = Destination.knownDestinations.get(key);
                const identity = await Identity.fromPublicKey(entry[2]);
                identity.app_data = entry[3];
                return identity;
            }
            return null;
        }
    }
}
