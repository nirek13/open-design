// The `od` object an app finds waiting for it.
//
// Injected into every app's document. It is deliberately tiny and dependency
// free: it wraps `postMessage` in promises so an app author writes
// `await od.query('invoices')` instead of correlating message ids by hand.
//
// It grants nothing. Every call still crosses the bridge and is checked
// against the app's declared scopes by the host — this is ergonomics, not
// authority. An app that skips the SDK and posts messages itself is subject to
// exactly the same checks.
//
// Written as a string because it has to run inside the sandboxed frame, which
// has no module loader and no network to fetch one from.

/** Bumped alongside APP_BRIDGE_PROTOCOL in contracts. */
const PROTOCOL = 1;

export const APP_SDK_SOURCE = `
(function () {
  var PROTOCOL = ${PROTOCOL};
  var pending = {};
  var counter = 0;

  window.addEventListener('message', function (event) {
    var reply = event.data;
    if (!reply || reply.protocol !== PROTOCOL || typeof reply.id !== 'string') return;
    var entry = pending[reply.id];
    if (!entry) return;
    delete pending[reply.id];
    if (reply.ok) entry.resolve(reply.result);
    else entry.reject(new Error(reply.error || 'refused'));
  });

  function send(payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      counter += 1;
      var id = 'r' + counter + '-' + Math.random().toString(36).slice(2, 8);
      pending[id] = { resolve: resolve, reject: reject };
      payload.protocol = PROTOCOL;
      payload.id = id;
      // The host is the only other party this frame can reach.
      parent.postMessage(payload, '*');
      // A request that never comes back would leak an entry and hang the
      // caller; failing loudly after a while is kinder than a silent stall.
      setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          reject(new Error('the host did not answer in time'));
        }
      }, timeoutMs || 15000);
    });
  }

  window.od = {
    /** Which tables this app may touch, so it can adapt instead of guessing. */
    scopes: function () {
      return send({ kind: 'scopes' });
    },
    /** Column names and types for a table. */
    describe: function (table) {
      return send({ kind: 'describe', table: table });
    },
    /** Rows, optionally filtered and sorted. Capped by the host. */
    query: function (table, options) {
      options = options || {};
      return send({
        kind: 'query',
        table: table,
        filters: options.filters,
        sort: options.sort,
        limit: options.limit,
      }).then(function (result) {
        return result.records;
      });
    },
    /** Add a row. Needs a write scope on the table. */
    create: function (table, data) {
      return send({ kind: 'create', table: table, data: data       }).then(function (result) {
        return result.record;
      });
    },
    /** Send Gmail as the connected organization account. Needs a gmail
     * write scope at publish time; the host still makes the call. */
    mail: {
      send: function (input) {
        input = input || {};
        return send({
          kind: 'mail.send',
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          body: input.body,
          isHtml: input.isHtml,
        }, 30000);
      },
    },
    /** Change a row. Needs a write scope on the table. */
    update: function (table, recordId, data) {
      return send({ kind: 'update', table: table, recordId: recordId, data: data }).then(
        function (result) {
          return result.record;
        },
      );
    },
    /** Money is integer minor units everywhere in this product; these are the
     * two conversions an app should ever need. */
    money: {
      toText: function (minor) {
        return typeof minor === 'number' ? (minor / 100).toFixed(2) : '';
      },
      fromText: function (text) {
        var parsed = parseFloat(String(text).replace(/[^0-9.-]/g, ''));
        return isFinite(parsed) ? Math.round(parsed * 100) : null;
      },
    },
  };
})();
`;
