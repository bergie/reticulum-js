/**
 * @module segment
 * @description Re-exported Resource segment sizing, so the transport can
 * estimate split-resource totals without reaching into `@reticulum/core`
 * internals.
 */

// `@reticulum/core` does not export this constant on its public surface;
// import the resource module directly. It is stable protocol surface
// (PROTOCOL-SPEC.md §10.3): payloads over this size split into segments.
import { Resource } from "@reticulum/core";

/** Logical bytes per Resource segment (§10.3). */
export const MAX_EFFICIENT_SIZE = Resource.MAX_EFFICIENT_SIZE;
