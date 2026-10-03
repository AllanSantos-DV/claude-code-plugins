'use strict';

/**
 * Settle `promise` within `ms` WITHOUT throwing, so a dispatcher can tell the
 * three cases apart (a detector that answered, timed out, or crashed):
 * { status:'ok', value } | { status:'timeout' } | { status:'error', err }.
 */
function settleWithin(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ status: 'timeout' }), ms);
    promise.then(
      (value) => { clearTimeout(t); resolve({ status: 'ok', value }); },
      (err) => { clearTimeout(t); resolve({ status: 'error', err }); },
    );
  });
}

module.exports = { settleWithin };
