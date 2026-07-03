/**
 * @file destination.js
 * @description Routing targets (EventTargets)
 */

import { Identity } from './identity.js';
import { Packet, PacketType, HeaderType, DestType } from './packet.js';
import { generateX25519KeyPair, generateEd25519KeyPair, exportPublicKey } from '../crypto/keys.js';
import { Link } from '../transport/link.js';

/**
 * @enum {number}
 */
export const Direction = {
    IN: 0,
    OUT: 1
};

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
/**
 * @param {Uint8Array} buf
 * @returns {string}
 */
function bufToHex(buf) {
    return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {string} hex
 * @returns {Uint8Array}
 */
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
     * @type {Map<string, any[]>}
     */
    static knownDestinations = new Map();

    /**
     * @param {string} name - The application name.
     * @param {Direction} direction - The direction of this destination.
     * @param {DestinationType} type - The type of this destination.
     * @param {Identity|null} identity - The identity associated with this destination.
     */
    constructor(name, direction, type, identity = null) {
        super();
        this.name = name;
        this.direction = direction;
        this.type = type;
        this.identity = identity;
        this.destinationHash = null;
        this.nameHash = null;
    }

    /**
     * Static factory for creating a destination.
     * @param {string} name
     * @param {Direction} direction
     * @param {DestinationType} type
     * @param {Identity|null} identity
     * @returns {Promise<Destination>}
     */
    static async create(name, direction, type, identity = null) {
        const dest = new Destination(name, direction, type, identity);
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
        return await this.create(name, Direction.IN, type, identity);
    }

    /**
     * Creates an OUT destination.
     * @param {string} name
     * @param {DestinationType} type
     * @param {Identity|null} identity
     * @returns {Promise<Destination>}
     */
    static async OUT(name, type, identity = null) {
        return await this.create(name, Direction.OUT, type, identity);
    }

    /**
     * Creates a SINGLE destination.
     * @param {string} name
     * @param {Direction} direction
     * @param {Identity|null} identity
     * @returns {Promise<Destination>}
     */
    static async SINGLE(name, direction, identity = null) {
        return await this.create(name, direction, DestinationType.SINGLE, identity);
    }

    /**
     * Creates a GROUP destination.
     * @param {string} name
     * @param {Direction} direction
     * @param {Identity|null} identity
     * @returns {Promise<Destination>}
     */
    static async GROUP(name, direction, identity = null) {
        return await this.create(name, direction, DestinationType.GROUP, identity);
    }

    /**
     * Creates a PLAIN destination.
     * @param {string} name
     * @param {Direction} direction
     * @returns {Promise<Destination>}
     */
    static async PLAIN(name, direction) {
        return await this.create(name, direction, DestinationType.PLAIN, null);
    }

    /**
     * Requests an encrypted link to this remote destination.
     * @param {import('../transport/transport.js').Transport} transport - The transport interface to use.
     * @param {Uint8Array} appData - Optional contextual data (e.g., Graph ID, Auth Token)
     * @param {number} timeoutMs - How long to wait for the remote node to accept
     * @returns {Promise<import('../transport/link.js').Link>} Resolves when the secure tunnel is established
     */
    async createLink(transport, appData = new Uint8Array(0), timeoutMs = 15000) {
        if (this.direction !== Direction.OUT) {
            throw new Error("Can only initiate links to OUT destinations.");
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.removeEventListener('link_established', onLinkEstablished);
                reject(new Error("Link request timed out."));
            }, timeoutMs);

            const onLinkEstablished = (event) => {
                clearTimeout(timer);
                resolve(event.detail.link);
            };

            this.addEventListener('link_established', onLinkEstablished, { once: true });

            (async () => {
                try {
                    const x25519 = await generateX25519KeyPair();
                    const ed25519 = await generateEd25519KeyPair();
                    const x25519PubBytes = await exportPublicKey(x25519.publicKey);
                    const ed25519PubBytes = await exportPublicKey(ed25519.publicKey);

                    const payload = new Uint8Array(64 + appData.length);
                    payload.set(x25519PubBytes, 0);
                    payload.set(ed25519PubBytes, 32);
                    payload.set(appData, 64);

                    const packet = new Packet({
                        headerType: HeaderType.HEADER_1,
                        hops: 0,
                        transportType: 0,
                        destinationType: this.type,
                        packetType: PacketType.LINKREQUEST,
                        contextFlag: false,
                        destinationHash: this.destinationHash,
                        payload: payload
                    });

                    await transport.sendPacket(packet);
                } catch (e) {
                    clearTimeout(timer);
                    this.removeEventListener('link_established', onLinkEstablished);
                    reject(e);
                }
            })();
        });
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
        const entry = Destination.knownDestinations.get(key);
        if (entry) {
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
            const entry = Destination.knownDestinations.get(key);
            if (entry) {
                const identity = await Identity.fromPublicKey(entry[2]);
                identity.app_data = entry[3];
                return identity;
            }
            return null;
        }
    }
}
