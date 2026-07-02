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
 * Represents a Reticulum destination.
 */
export class Destination extends EventTarget {
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
        this.destination_hash = null;
        this.name_hash = null;
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
        await dest._compute_hashes();
        return dest;
    }

    /**
     * Computes the name_hash and destination_hash.
     * @private
     */
    async _compute_hashes() {
        const encoder = new TextEncoder();
        const nameBytes = encoder.encode(this.name);
        
        // name_hash = SHA256(full_app_name_string)[:10]
        const nameHashBuffer = await crypto.subtle.digest("SHA-256", nameBytes);
        this.name_hash = new Uint8Array(nameHashBuffer.slice(0, 10));

        if (this.type === DestinationType.SINGLE && this.identity) {
            // dest_hash = SHA256(name_hash || identity_hash)[:16]
            const combined = new Uint8Array(this.name_hash.length + this.identity.identity_hash.length);
            combined.set(this.name_hash, 0);
            combined.set(this.identity.identity_hash, this.name_hash.length);

            const destHashBuffer = await crypto.subtle.digest("SHA-256", combined);
            this.destination_hash = new Uint8Array(destHashBuffer.slice(0, 16));
        } else if (this.type === DestinationType.GROUP && this.identity) {
             // Same as SINGLE for GROUP
            const combined = new Uint8Array(this.name_hash.length + this.identity.identity_hash.length);
            combined.set(this.name_hash, 0);
            combined.set(this.identity.identity_hash, this.name_hash.length);

            const destHashBuffer = await crypto.subtle.digest("SHA-256", combined);
            this.destination_hash = new Uint8Array(destHashBuffer.slice(0, 16));
        } else if (this.type === DestinationType.PLAIN) {
            // dest_hash = SHA256(name_hash)[:16]
            const destHashBuffer = await crypto.subtle.digest("SHA-256", this.name_hash);
            this.destination_hash = new Uint8Array(destHashBuffer.slice(0, 16));
        } else {
            this.destination_hash = null;
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
}
