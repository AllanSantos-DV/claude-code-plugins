'use strict';
/**
 * lib/refused-retry.js — what the REST clients of the memory daemon share to ride out a brief
 * restart: which errors mean "nobody is listening right now" and the bounded backoff between tries.
 */

const RETRY_DELAYS_MS = [250, 500, 1000];
const NEVER_REACHED = new Set(['ECONNREFUSED', 'EADDRNOTAVAIL']);
const RESTARTING = new Set([...NEVER_REACHED, 'ECONNRESET']);

const codeOf = (err) => (err && err.cause && err.cause.code) || (err && err.code) || '';

/**
 * @param {unknown} err a fetch rejection (undici puts the socket code in `err.cause.code`)
 * @returns {boolean} true when the connection was refused or dropped before any answer
 */
function isRefused(err) {
  return RESTARTING.has(codeOf(err));
}

/**
 * @param {unknown} err a fetch rejection
 * @returns {boolean} true only when the request never reached the daemon (a reset may come after it stored a write)
 */
function neverReached(err) {
  return NEVER_REACHED.has(codeOf(err));
}

/** @param {unknown} err @returns {string} the socket code, or the message when there is none */
function refusedCode(err) {
  return (err && err.cause && err.cause.code) || (err && err.code) || String(err && err.message || err);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { RETRY_DELAYS_MS, isRefused, neverReached, refusedCode, sleep };
