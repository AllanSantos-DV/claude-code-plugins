'use strict';

const LATE_MS = 50;

/**
 * Settle `promise` within `ms` WITHOUT throwing, so a dispatcher can tell the
 * three cases apart (a detector that answered, timed out, or crashed):
 * { status:'ok', value } | { status:'timeout' } | { status:'error', err }.
 *
 * Synchronous work in the same process starves the event loop: a timer then fires
 * late, before the I/O that would have settled the promise was ever serviced. The
 * ceiling therefore counts only the time the loop was free: when the timer fires
 * late, the deadline is extended once by that lateness (capped at `ms`).
 */
function settleWithin(promise, ms) {
  return new Promise((resolve) => {
    const due = Date.now() + ms;
    let t = setTimeout(() => {
      const late = Date.now() - due;
      if (late <= LATE_MS) return resolve({ status: 'timeout' });
      t = setTimeout(() => resolve({ status: 'timeout' }), Math.min(late, ms));
    }, ms);
    promise.then(
      (value) => { clearTimeout(t); resolve({ status: 'ok', value }); },
      (err) => { clearTimeout(t); resolve({ status: 'error', err }); },
    );
  });
}

module.exports = { settleWithin };
