/**
 * @file constants.js
 * @description LXMF field constants, audio modes, renderers, and related
 *   specifiers. Mirrors `LXMF/LXMF.py` (verified against LXMF 1.0.1).
 */

/**
 * Application name for the LXMF delivery destination.
 */
export const APP_NAME = "lxmf";

// --- Top-level `fields` dict keys (§5.9.1) ---
/** A list of further LXMF messages embedded inside this one. */
export const FIELD_EMBEDDED_LXMS = 0x01;
/** A single telemetry snapshot. */
export const FIELD_TELEMETRY = 0x02;
/** A list of telemetry snapshots (history flush). */
export const FIELD_TELEMETRY_STREAM = 0x03;
/** Sender-supplied avatar / appearance hint. */
export const FIELD_ICON_APPEARANCE = 0x04;
/** A list of attached files (§5.9.7). */
export const FIELD_FILE_ATTACHMENTS = 0x05;
/** Single embedded image — `[extension, image_bytes]` (§5.9.2). */
export const FIELD_IMAGE = 0x06;
/** Single embedded audio clip — `[mode_byte, audio_bytes]` (§5.9.3). */
export const FIELD_AUDIO = 0x07;
/** Conversation thread ID (links related messages). */
export const FIELD_THREAD = 0x08;
/** List of commands the sender requests the receiver execute. */
export const FIELD_COMMANDS = 0x09;
/** List of results for commands previously requested. */
export const FIELD_RESULTS = 0x0a;
/** Group / channel association metadata. */
export const FIELD_GROUP = 0x0b;
/** Stamp ticket grant — `[expires_unix_seconds, ticket_bytes]` (§5.7). */
export const FIELD_TICKET = 0x0c;
/** Event-style payload (alert, state change). */
export const FIELD_EVENT = 0x0d;
/** Reticulum Node Registry references. */
export const FIELD_RNR_REFS = 0x0e;
/** Renderer hint for the message content body (§5.9.4). */
export const FIELD_RENDERER = 0x0f;
/** Raw 32-byte LXMessage.hash being replied to (§5.9.9). */
export const FIELD_REPLY_TO = 0x30;
/** Optional UTF-8 quoted content bytes (§5.9.9). */
export const FIELD_REPLY_QUOTE = 0x31;
/** Reaction dict (§5.9.8). */
export const FIELD_REACTION = 0x40;
/** Comment dict containing `COMMENT_FOR`. */
export const FIELD_COMMENT = 0x41;
/** Continuation dict containing `CONTINUATION_OF`. */
export const FIELD_CONTINUATION = 0x42;
/** App-defined type identifier accompanying FIELD_CUSTOM_DATA. */
export const FIELD_CUSTOM_TYPE = 0xfb;
/** App-defined opaque data — meaning given by FIELD_CUSTOM_TYPE. */
export const FIELD_CUSTOM_DATA = 0xfc;
/** App-defined metadata alongside FIELD_CUSTOM_DATA. */
export const FIELD_CUSTOM_META = 0xfd;
/** Development / unstructured payload — not for production. */
export const FIELD_NON_SPECIFIC = 0xfe;
/** Debug payload — not for production. */
export const FIELD_DEBUG = 0xff;

// --- Audio modes for FIELD_AUDIO (§5.9.3) ---
// Codec2 Audio Modes
export const AM_CODEC2_450PWB = 0x01;
export const AM_CODEC2_450 = 0x02;
export const AM_CODEC2_700C = 0x03;
export const AM_CODEC2_1200 = 0x04;
export const AM_CODEC2_1300 = 0x05;
export const AM_CODEC2_1400 = 0x06;
export const AM_CODEC2_1600 = 0x07;
export const AM_CODEC2_2400 = 0x08;
export const AM_CODEC2_3200 = 0x09;
// Opus Audio Modes
export const AM_OPUS_OGG = 0x10;
export const AM_OPUS_LBW = 0x11;
export const AM_OPUS_MBW = 0x12;
export const AM_OPUS_PTT = 0x13;
export const AM_OPUS_RT_HDX = 0x14;
export const AM_OPUS_RT_FDX = 0x15;
export const AM_OPUS_STANDARD = 0x16;
export const AM_OPUS_HQ = 0x17;
export const AM_OPUS_BROADCAST = 0x18;
export const AM_OPUS_LOSSLESS = 0x19;
/** Custom audio mode — client must inspect the data to determine codec. */
export const AM_CUSTOM = 0xff;

// --- Message renderer specifications for FIELD_RENDERER (§5.9.4) ---
/** Plain text — no formatting. */
export const RENDERER_PLAIN = 0x00;
/** NomadNet Micron markup. */
export const RENDERER_MICRON = 0x01;
/** CommonMark / GitHub-flavored Markdown. */
export const RENDERER_MARKDOWN = 0x02;
/** BBCode-style tags. */
export const RENDERER_BBCODE = 0x03;

// --- Reaction dict indices (value of FIELD_REACTION, §5.9.8) ---
/** Bytes — full LXMessage.hash the reaction targets. */
export const REACTION_TO = 0x00;
/** Bytes — the reaction content in UTF-8 encoding. */
export const REACTION_CONTENT = 0x01;

// --- Comment dict indices (value of FIELD_COMMENT) ---
/** Bytes — full LXMessage.hash the comment is for. */
export const COMMENT_FOR = 0x00;

// --- Continuation dict indices (value of FIELD_CONTINUATION) ---
/** Bytes — full LXMessage.hash this message continues. */
export const CONTINUATION_OF = 0x00;

// --- Propagation-node metadata keys (§5.9.5) — unstable until LXMF 1.0.0 ---
/** Propagation protocol version. */
export const PN_META_VERSION = 0x00;
/** Operator-supplied node name. */
export const PN_META_NAME = 0x01;
/** Sync tier in the propagation mesh. */
export const PN_META_SYNC_STRATUM = 0x02;
/** Operator-imposed sync throttle. */
export const PN_META_SYNC_THROTTLE = 0x03;
/** Auth requirement (open / restricted / private). */
export const PN_META_AUTH_BAND = 0x04;
/** Utilization back-pressure hint. */
export const PN_META_UTIL_PRESSURE = 0x05;
/** Operator-defined extensions. */
export const PN_META_CUSTOM = 0xff;

// --- Functionality signalling keys (§5.9.6) ---
/** Sender supports compressed message bodies. */
export const SF_COMPRESSION = 0x00;
