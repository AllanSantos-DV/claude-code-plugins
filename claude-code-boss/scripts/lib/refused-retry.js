'use strict';
/**
 * lib/refused-retry.js — what the REST clients of the memory daemon share to ride out a brief
 * restart: which errors mean "nobody is listening right now" and the bounded backoff between tries.
 */

const RETRY_DELAYS_MS = [250, 500, 1000];
const RESTARTING = new Set(['ECONNREFUSED', 'ECONNRESET', 'EADDRNOTAVAIL']);

/**
 * @param {unknown} err a fetch rejection (undici puts the socket code in `err.cause.code`)
 * @returns {boolean} true when the connection was refused or dropped before any answer
 */
function isRefused(err) {
  return RESTARTING.has((err && err.cause && err.cause.code) || (err && err.code) || '');
}

/** @param {unknown} err @returns {string} the socket code, or the message when there is none */
function refusedCode(err) {
  return (err && err.cause && err.cause.code) || (err && err.code) || String(err && err.message || err);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { RETRY_DELAYS_MS, isRefused, refusedCode, sleep };
