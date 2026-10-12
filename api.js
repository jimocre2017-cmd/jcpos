/* Jimo Cafe POS アプリ版：通信・オフライン保存・同期
 *
 * もとの POS 画面（GAS版）は google.script.run でサーバーを呼んでいる。
 * このファイルは google.script.run と同じ書き方で呼べる代わりの仕組みを用意し、
 *   - 注文・注文取消・会計 … オフラインでも受け付けて端末に保存し、通信が戻ったら自動送信
 *   - メニュー・スタッフ・顧客候補・未精算一覧 … 最後に取得した内容を端末に保存し、オフラインでも表示
 *   - それ以外（チケット・日報・分析・取消修正など）… オンラインの時だけ
 * にする。注文ID・会計IDは端末で採番するので、何度送り直しても二重登録・二重会計にならない。
 */
var JCPOS = (function () {
  'use strict';

  /* ---------- 端末内の保存 ---------- */
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  var TABLES = ['1', '2', '3', '4', '5', '6', 'C1', 'C2', '2F', 'TO'];

  /* ---------- 端末の設定（APIのURLと合言葉） ---------- */
  function parseSetup(text) {
    var s = String(text || '').trim();
    var m = s.match(/#setup=(.+)$/);
    if (m) s = m[1];
    try { s = decodeURIComponent(s); } catch (e) {}
    try {
      var c = JSON.parse(s);
      if (c && /^https:\/\/script\.google\.com\//.test(c.api) && c.token) return { api: c.api, token: String(c.token) };
    } catch (e) {}
    return null;
  }
  var justConfigured = false;
  (function () {
    var m = location.hash.match(/^#setup=(.+)$/);
    if (!m) return;
    var c = parseSetup(location.hash);
    if (c) { LS.set('jc_cfg', c); justConfigured = true; }
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  })();
  function cfg() { return LS.get('jc_cfg', null); }

  /* ---------- 日付・ID ---------- */
  function p2(n) { return ('0' + n).slice(-2); }
  function nowStr() {
    var d = new Date();
    return d.getFullYear() + '/' + p2(d.getMonth() + 1) + '/' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  }
  function rand36(n) {
    var chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', out = '', buf = new Uint8Array(n);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(buf); else for (var i = 0; i < n; i++) buf[i] = Math.random() * 256 | 0;
    for (var j = 0; j < n; j++) out += chars[buf[j] % 36];
    return out;
  }
  function newOrderId() { return 'ORD-A' + rand36(12); }      // サーバー側 isAppOrderId_ と同じ形式
  function newCheckoutId() { return 'APP-' + uuid().toLowerCase(); } // サーバー側 isAppCheckoutId_ と同じ形式
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------- サーバー呼び出し ---------- */
  function netErr(msg) { var e = new Error('オフラインのため通信できません'); e.offline = true; e.detail = msg; return e; }

  function api(fn, args, timeoutMs) {
    var c = cfg();
    if (!c) { var e0 = new Error('この端末はまだ設定されていません'); e0.nocfg = true; return Promise.reject(e0); }
    if (navigator.onLine === false) return Promise.reject(netErr('offline'));
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, timeoutMs || 30000);
    return fetch(c.api, {
      method: 'POST',
      body: JSON.stringify({ token: c.token, fn: fn, args: args || [] }),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      if (!r.ok) throw netErr('HTTP ' + r.status);
      return r.json().catch(function () { throw netErr('bad json'); });
    }, function (err) {
      throw netErr(err && err.message);
    }).then(function (j) {
      clearTimeout(timer);
      setOnline(true);
      if (!j.ok) {
        var msg = String(j.error || 'エラー');
        var e = new Error(msg.replace(/^AUTH: /, ''));
        if (/^AUTH/.test(msg)) { e.auth = true; status.authError = true; emitStatus(); }
        throw e;
      }
      return j.data;
    }, function (err) {
      clearTimeout(timer);
      if (err.offline) setOnline(false);
      throw err;
    });
  }

  /* ---------- 送信待ち（キュー）と送信できなかった操作 ---------- */
  function queue() { return LS.get('jc_queue', []); }
  function setQueue(q) { LS.set('jc_queue', q); emitStatus(); }
  function failed() { return LS.get('jc_failed', []); }
  function setFailed(f) { LS.set('jc_failed', f); emitStatus(); }

  /* ---------- 状態 ---------- */
  var status = { online: navigator.onLine !== false, syncing: false, authError: false };
  var statusCbs = [];
  function setOnline(v) { if (status.online !== v) { status.online = v; emitStatus(); } }
  function statusInfo() {
    return { online: status.online, syncing: status.syncing, authError: status.authError, pending: queue().length, failed: failed().length, configured: !!cfg(), syncedAt: LS.get('jc_synced', 0) };
  }
  function emitStatus() { var s = statusInfo(); statusCbs.forEach(function (f) { try { f(s); } catch (e) {} }); }

  /* ---------- 未精算一覧（サーバーの最新＋この端末の送信待ち） ---------- */
  var snapGen = 0;
  function saveSnapshot(summary) {
    if (!summary) return;
    LS.set('jc_unpaid', { t: Date.now(), summary: summary });
    LS.set('jc_synced', Date.now());
    snapGen++;
  }
  function emptySummary() { var s = {}; TABLES.forEach(function (t) { s[t] = []; }); return s; }

  function findItem(view, orderId) {
    var id = String(orderId);
    var tables = Object.keys(view);
    for (var i = 0; i < tables.length; i++) {
      var arr = view[tables[i]] || [];
      for (var j = 0; j < arr.length; j++) if (String(arr[j].orderId) === id) return { table: tables[i], arr: arr, idx: j, item: arr[j] };
    }
    return null;
  }

  function applyOp(view, op) {
    if (op.type === 'order') {
      var res = op.reservationData || {};
      var arr = view[op.tableId] = view[op.tableId] || [];
      (op.items || []).forEach(function (it) {
        if (findItem(view, it.orderId)) return;
        arr.push({
          orderId: it.orderId, table: op.tableId, mealType: it.mealType || 'ランチ', course: it.course || 'その他',
          name: it.name, qty: Number(it.qty) || 1, price: Number(it.price) || 0, status: '注文中', rowIndex: 0,
          peopleCount: res.peopleCount || '', custName: String(res.name || ''), custPhone: String(res.phone || '').replace(/^'+/, ''),
          pending: true
        });
      });
    } else if (op.type === 'cancelItem') {
      var f = findItem(view, op.orderId);
      if (f) f.arr.splice(f.idx, 1);
    } else if (op.type === 'checkout') {
      var p = op.params || {};
      (p.orderItems || []).forEach(function (oi) {
        var g = findItem(view, oi.orderId);
        if (!g) return;
        var full = Number(g.item.qty) || 1;
        var q = (oi.qty === null || oi.qty === undefined) ? full : Number(oi.qty);
        if (q >= full) g.arr.splice(g.idx, 1);
        else g.item.qty = full - Math.max(1, q);
      });
    }
  }

  function localView() {
    var snap = LS.get('jc_unpaid', null);
    var view = snap ? clone(snap.summary) : emptySummary();
    TABLES.forEach(function (t) { if (!view[t]) view[t] = []; });
    queue().forEach(function (op) { applyOp(view, op); });
    return view;
  }

  function fetchSnapshot() {
    var gen = snapGen;
    return api('getAllTablesUnpaidSummary', [], 15000).then(function (summary) {
      if (gen === snapGen) saveSnapshot(summary); // 取得中に送信が終わっていたら古い結果なので使わない
      return localView();
    }, function (e) {
      if (e.offline || e.nocfg) return localView();
      throw e;
    });
  }

  /* ---------- 送信（すべての送信を1本の列に並べて、順番を守る） ---------- */
  var chain = Promise.resolve();
  function serial(fn) {
    var p = chain.then(fn, fn);
    chain = p.then(function () {}, function () {});
    return p;
  }

  // 送信待ちを送る。結果のない操作（時間切れ・混雑）は残して次回送る
  function flushNow() {
    var q = queue();
    if (!q.length || !cfg()) return Promise.resolve(statusInfo());
    var batch = q.slice(0, 20);
    status.syncing = true; emitStatus();
    return api('syncOps', [batch], 300000).then(function (res) {
      var done = {};
      (res.results || []).forEach(function (r) { done[r.qid] = r; });
      var fl = failed();
      batch.forEach(function (op) {
        var r = done[op.qid];
        if (r && !r.ok) { op.error = r.error; op.failedAt = nowStr(); fl.push(op); }
      });
      setFailed(fl);
      setQueue(queue().filter(function (op) { return !done[op.qid]; }));
      saveSnapshot(res.unpaid);
      status.syncing = false; emitStatus();
      var failedNow = batch.filter(function (op) { var r = done[op.qid]; return r && !r.ok; });
      if (failedNow.length) notify('送信できなかった操作が ' + failedNow.length + ' 件あります（画面下の⚠から確認）', true);
      fireSynced();
      if (queue().length && (res.results || []).length) return flushNow();
      return statusInfo();
    }, function (e) {
      status.syncing = false; emitStatus();
      throw e;
    });
  }
  function sync() { return serial(flushNow); }

  var syncTimer = null;
  function schedule(ms) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { sync().catch(function () {}); }, ms || 300);
  }

  // 1件の操作を送る：送信待ちが無くオンラインならすぐ送り、届かなければ送信待ちに入れる
  // 戻り値 { ok, queued, error, total }
  function submit(op) {
    return serial(function () {
      if (queue().length || navigator.onLine === false) {
        enqueue(op);
        return { ok: true, queued: true };
      }
      return api('syncOps', [[op]], 120000).then(function (res) {
        saveSnapshot(res.unpaid);
        var r = (res.results || [])[0];
        fireSynced();
        if (!r) { enqueue(op); return { ok: true, queued: true }; } // 混雑で処理されなかった → あとで送る
        return { ok: r.ok, error: r.error, total: r.total };
      }, function (e) {
        if (e.offline) { enqueue(op); return { ok: true, queued: true }; }
        throw e;
      });
    });
  }
  function enqueue(op) {
    var q = queue(); var backlog = q.length; q.push(op); setQueue(q);
    if (status.online && navigator.onLine !== false && backlog) {
      notify('未送信の操作のあとに順番に送信します');
      schedule(300);
    } else {
      notify('オフラインのため端末に保存しました。通信が戻ると自動で送信します');
      schedule(15000);
    }
  }

  var syncedTimer = null;
  function fireSynced() {
    clearTimeout(syncedTimer);
    syncedTimer = setTimeout(function () {
      try { window.dispatchEvent(new Event('jcpos:synced')); } catch (e) {}
    }, 50);
  }

  /* ---------- 読み取りのキャッシュ（オフラインでは最後に取得した内容） ---------- */
  function cachedRead(fn, args, key, fallback) {
    var c = LS.get(key, null);
    return api(fn, args, c ? 10000 : 25000).then(function (d) {
      LS.set(key, { t: Date.now(), d: d });
      return d;
    }, function (e) {
      if (!(e.offline || e.nocfg)) throw e;
      if (c) return c.d;
      if (fallback !== undefined) return fallback;
      throw new Error('オフラインです。一度オンラインで開くと、以後はオフラインでも表示できます');
    });
  }

  function onlineOnly(fn, args, label) {
    return api(fn, args, 60000).catch(function (e) {
      if (e.offline) throw new Error('オフラインのため' + (label || 'この操作') + 'はできません（注文・会計はオフラインでも使えます）');
      throw e;
    });
  }

  function pendingOrderOp(orderId) {
    var q = queue(), id = String(orderId);
    for (var i = 0; i < q.length; i++) {
      if (q[i].type !== 'order') continue;
      for (var j = 0; j < q[i].items.length; j++) if (String(q[i].items[j].orderId) === id) return { q: q, op: q[i], idx: j };
    }
    return null;
  }

  function menuPrice(name) {
    var c = LS.get('jc_menu', null), list = c ? c.d : [];
    for (var i = 0; i < (list || []).length; i++) if (String(list[i]['メニュー名'] || '').trim() === name) return Number(list[i]['価格'] || 0);
    return null;
  }

  // 日報など「全部送ってから」でないと数字がずれる操作の前に呼ぶ
  function requireFlushed(label) {
    if (!queue().length) return Promise.resolve();
    return sync().catch(function () {}).then(function () {
      var n = queue().length;
      if (n) throw new Error('この端末に未送信の注文・会計が ' + n + ' 件あります。通信が戻って送信が終わってから' + label + 'を開いてください');
    });
  }

  /* ---------- 画面から呼ぶ関数（GAS版と同じ名前・同じ戻り値） ---------- */
  var handlers = {
    getMenuList: function () { return cachedRead('getMenuList', [], 'jc_menu'); },
    getStaffList: function () { return cachedRead('getStaffList', [], 'jc_staff', ['髙橋']); },
    getCustomerLookupData: function () { return cachedRead('getCustomerLookupData', [], 'jc_custlookup', []); },
    getTodayReservations: function () { return cachedRead('getTodayReservations', [], 'jc_resv', []); },
    getKitchenActiveOrders: function () { return cachedRead('getKitchenActiveOrders', [], 'jc_kitchen', {}); },
    getKitchenUrl: function () { return Promise.resolve('kitchen.html'); },

    getAllTablesUnpaidSummary: function () { return fetchSnapshot(); },
    getTableUnpaidItems: function (tableId) {
      return fetchSnapshot().then(function (v) { return { items: v[tableId] || [] }; });
    },

    addTableOrder: function (tableId, items, staffName, reservationData, requestId) {
      var list = (items || []).filter(function (it) { return it && it.name && Number(it.qty) > 0; }).map(function (it) {
        return { orderId: newOrderId(), name: it.name, qty: Number(it.qty), price: Number(it.price) || 0, mealType: it.mealType || 'ランチ', course: it.course || 'その他' };
      });
      if (!list.length) return Promise.resolve({ success: false, message: '注文する商品がありません' });
      var op = { qid: uuid(), type: 'order', tableId: String(tableId), items: list, staffName: staffName || '', reservationData: reservationData || null, requestId: requestId || '', at: nowStr() };
      return submit(op).then(function (r) {
        return r.ok ? { success: true, queued: !!r.queued } : { success: false, message: r.error };
      });
    },

    cancelTableOrderItem: function (orderId, tableId) {
      var pend = pendingOrderOp(orderId);
      if (pend) {
        // まだ送っていない注文 → 送信待ちから外すだけ
        pend.op.items.splice(pend.idx, 1);
        var q = pend.q.filter(function (op) { return !(op.type === 'order' && !op.items.length); });
        setQueue(q);
        return Promise.resolve({ success: true, remainingItems: localView()[tableId] || [] });
      }
      var op = { qid: uuid(), type: 'cancelItem', orderId: String(orderId), tableId: String(tableId), at: nowStr() };
      return submit(op).then(function (r) {
        return { success: r.ok, message: r.error, remainingItems: localView()[tableId] || [] };
      });
    },

    updateTableOrderItem: function (orderId, rowIndex, newName, newQty, newPrice) {
      var pend = pendingOrderOp(orderId);
      if (pend) {
        var name = String(newName || '').trim(), qty = Math.floor(Number(newQty));
        if (!name) return Promise.resolve({ success: false, message: '商品名を入力してください' });
        if (!(qty >= 1)) return Promise.resolve({ success: false, message: '数量は1以上で入力してください' });
        var hasPrice = newPrice !== '' && newPrice !== null && newPrice !== undefined && isFinite(Number(newPrice));
        var price = hasPrice ? Number(newPrice) : menuPrice(name);
        if (price === null) return Promise.resolve({ success: false, message: 'メニューにない商品は単価も入力してください' });
        var it = pend.op.items[pend.idx];
        it.name = name; it.qty = qty; it.price = price;
        setQueue(pend.q);
        return Promise.resolve({ success: true, remainingItems: localView()[pend.op.tableId] || [] });
      }
      return onlineOnly('updateTableOrderItem', [orderId, rowIndex, newName, newQty, newPrice], '送信済みの注文の修正').then(function (res) {
        if (!res || !res.success) return res;
        return fetchSnapshot().then(function (v) {
          var f = findItem(v, orderId);
          res.remainingItems = f ? v[f.table] : res.remainingItems;
          return res;
        });
      });
    },

    processTableSplitCheckout: function (params) {
      // 同じ会計を送り直した時に同じIDになるよう、画面側の params に会計IDを残す
      if (!params.checkoutId) params.checkoutId = newCheckoutId();
      if (!params.clientAt) params.clientAt = nowStr();
      var p = clone(params);
      var tableId = String(p.tableId);
      var view = localView();
      var items = view[tableId] || [];
      var orderItems = (p.orderItems && p.orderItems.length) ? p.orderItems : (p.orderIds || []).map(function (id) { return { orderId: id, qty: null }; });
      p.orderItems = orderItems;
      var total = 0, hit = 0;
      orderItems.forEach(function (oi) {
        var it = items.filter(function (x) { return String(x.orderId) === String(oi.orderId); })[0];
        if (!it) return;
        hit++;
        var full = Number(it.qty) || 1;
        var q = (oi.qty === null || oi.qty === undefined || Number(oi.qty) >= full) ? full : Math.max(1, Number(oi.qty));
        total += (Number(it.price) || 0) * q;
      });
      if (!hit) {
        return Promise.resolve({ success: false, alreadyPaid: true, message: 'この注文はすでに会計済みです（二重会計を防止しました）', hasRemaining: items.length > 0, remainingItems: items });
      }

      function remainingResult(extra) {
        var v = localView(), rest = v[tableId] || [];
        var out = { success: true, total: total, recordedAmount: total, ticketAmount: 0, ticketNote: '', hasRemaining: rest.length > 0, remainingItems: rest };
        Object.keys(extra || {}).forEach(function (k) { out[k] = extra[k]; });
        return out;
      }

      // お食事券の充当はオンラインの時だけ（残高の二重消化を防ぐため、サーバーで会計と同時に処理）
      if (p.ticketApplied) {
        return requireFlushed('チケット充当').then(function () {
          return serial(function () {
            return api('processTableSplitCheckout', [p], 120000);
          });
        }).then(function (res) {
          if (res && res.success) {
            if (res.duplicate) res.total = total;
            return fetchSnapshot().then(function () { fireSynced(); return remainingResult({ total: res.total, recordedAmount: res.recordedAmount, ticketAmount: res.ticketAmount, ticketNote: res.ticketNote }); });
          }
          return res;
        }, function (e) {
          if (e.offline) return { success: false, message: 'オフラインのため、お食事券の充当はできません。「チケット残高を充当する」のチェックを外して会計するか、通信が戻ってからもう一度お試しください' };
          return { success: false, message: e.message };
        });
      }

      delete p.ticketApplied;
      var op = { qid: uuid(), type: 'checkout', params: p, at: p.clientAt };
      return submit(op).then(function (r) {
        if (!r.ok) {
          var v = localView(), rest = v[tableId] || [];
          var paid = /会計済み/.test(r.error || '');
          return { success: false, alreadyPaid: paid, message: r.error, hasRemaining: rest.length > 0, remainingItems: rest };
        }
        return remainingResult({ queued: !!r.queued, total: r.total || total, recordedAmount: r.total || total });
      });
    },

    getActiveTicketByCustomer: function (query) {
      return api('getActiveTicketByCustomer', [query], 8000).catch(function (e) {
        if (e.offline) return { found: false, tickets: [] };
        throw e;
      });
    },

    getDailyReportData: function (key) {
      return requireFlushed('日報').then(function () { return onlineOnly('getDailyReportData', [key], '日報の表示'); });
    },
    commitDailyClosing: function (staff, key) {
      return requireFlushed('日報').then(function () { return onlineOnly('commitDailyClosing', [staff, key], '日報の確定'); });
    }
  };

  var LABELS = {
    getMealTickets: 'チケットの検索', issueMealTicketAndCheckout: 'チケットの発行', consumeMealTicket: 'チケットの消化',
    verifyAdminPin: '顧客管理', getCustomerList: '顧客管理', registerNewCustomer: '顧客の新規登録',
    getSalesAnalytics: '売上分析', getCheckoutsByDate: '会計の取消・修正', cancelCheckout: '会計の取消',
    updateCheckoutFields: '会計の修正', getCheckoutDetails: '会計の修正', updateCheckoutDetailItem: '会計の修正',
    toggleSeasonItemAvailability: '季節メニューの切替', processBackfillCheckout: '後入れ会計', setOrderItemsServed: '提供済の記録', markTableOrdersCompleted: '提供済の記録'
  };

  function call(fn, args) {
    var h = handlers[fn];
    try {
      if (h) return Promise.resolve(h.apply(null, args));
      return onlineOnly(fn, args, LABELS[fn] ? '「' + LABELS[fn] + '」' : '');
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /* ---------- google.script.run の代わり ---------- */
  function runner(ok, ng) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (f) { return runner(f, ng); };
        if (name === 'withFailureHandler') return function (f) { return runner(ok, f); };
        if (name === 'withUserObject') return function () { return runner(ok, ng); };
        if (typeof name !== 'string') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          call(name, args).then(function (r) {
            if (ok) ok(r);
          }, function (e) {
            if (ng) ng(e); else if (window.console) console.error(e);
          });
        };
      }
    });
  }
  window.google = window.google || {};
  window.google.script = { run: runner(null, null) };

  /* ---------- 自動送信のきっかけ ---------- */
  window.addEventListener('online', function () { status.online = true; emitStatus(); schedule(500); });
  window.addEventListener('offline', function () { status.online = false; emitStatus(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && cfg()) schedule(300); });
  setInterval(function () { if (queue().length && cfg()) sync().catch(function () {}); }, 30000);

  /* ---------- 画面下の状態表示・未送信／失敗の一覧・未設定時の設定画面 ---------- */
  var toastTimer = null;
  function notify(msg, warn) {
    var el = document.getElementById('jcpos-note');
    if (!el) return;
    el.textContent = msg;
    el.className = 'show' + (warn ? ' warn' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ''; }, warn ? 6000 : 3500);
  }

  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function tblName(t) { return t === 'C1' ? 'カウンター1' : t === 'C2' ? 'カウンター2' : t === '2F' ? '2F' : t === 'TO' ? 'テイクアウト' : t + '番卓'; }
  function opText(op) {
    if (op.type === 'order') return '注文 ' + tblName(op.tableId) + '：' + op.items.map(function (i) { return i.name + '×' + i.qty; }).join('、');
    if (op.type === 'cancelItem') return '注文取消 ' + tblName(op.tableId) + '（' + op.orderId + '）';
    if (op.type === 'checkout') return '会計 ' + tblName(op.params.tableId) + '（' + (op.params.paymentMethod || '') + '・' + (op.params.orderItems || []).length + '品）';
    return op.type;
  }

  function injectUi() {
    var css = document.createElement('style');
    css.textContent =
      '#jcpos-pill{position:fixed;left:8px;bottom:calc(var(--jcpos-pill-bottom, 8px) + env(safe-area-inset-bottom));z-index:99990;font:700 11px/1 "Noto Sans JP",sans-serif;padding:7px 10px;border-radius:999px;background:rgba(43,33,26,.86);color:#fff;display:flex;gap:6px;align-items:center;cursor:pointer;-webkit-user-select:none;user-select:none;}' +
      '#jcpos-pill .dot{width:8px;height:8px;border-radius:50%;background:#27ae60;}#jcpos-pill.off .dot{background:#e67e22;}#jcpos-pill.err{background:#c0392b;}' +
      '#jcpos-note{position:fixed;left:50%;bottom:calc(var(--jcpos-pill-bottom, 8px) + 44px + env(safe-area-inset-bottom));transform:translateX(-50%) translateY(20px);opacity:0;pointer-events:none;z-index:99991;max-width:92vw;background:#2b211a;color:#fff;font:700 13px/1.5 "Noto Sans JP",sans-serif;padding:10px 14px;border-radius:12px;transition:.25s;box-shadow:0 4px 16px rgba(0,0,0,.25);}' +
      '#jcpos-note.show{opacity:1;transform:translateX(-50%) translateY(0);}#jcpos-note.warn{background:#c0392b;}' +
      '#jcpos-panel,#jcpos-setup{position:fixed;inset:0;z-index:99995;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center;padding:16px;}' +
      '#jcpos-panel.open,#jcpos-setup.open{display:flex;}' +
      '.jcpos-box{background:#fff;color:#2b211a;border-radius:16px;max-width:520px;width:100%;max-height:85vh;overflow:auto;padding:18px;font:14px/1.6 "Noto Sans JP",sans-serif;}' +
      '.jcpos-box h3{margin:0 0 8px;font-size:16px;}.jcpos-box .sub{font-size:12px;color:#6b5d4f;}' +
      '.jcpos-row{border:1px solid #e8dcca;border-radius:10px;padding:8px 10px;margin:6px 0;font-size:12px;}.jcpos-row .er{color:#c0392b;font-weight:700;}' +
      '.jcpos-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;}.jcpos-btns button{flex:1;min-width:120px;padding:12px;border-radius:10px;border:1px solid #e8dcca;background:#f7f2ea;font:700 14px "Noto Sans JP",sans-serif;color:#2b211a;}' +
      '.jcpos-btns button.pri{background:#c8672c;border-color:#c8672c;color:#fff;}' +
      '#jcpos-setup textarea{width:100%;min-height:90px;border:1px solid #e8dcca;border-radius:10px;padding:10px;font:12px monospace;box-sizing:border-box;}';
    document.head.appendChild(css);

    var pill = document.createElement('div'); pill.id = 'jcpos-pill';
    pill.innerHTML = '<span class="dot"></span><span class="txt">接続確認中</span>';
    pill.onclick = openPanel;
    var note = document.createElement('div'); note.id = 'jcpos-note';
    var panel = document.createElement('div'); panel.id = 'jcpos-panel';
    panel.onclick = function (e) { if (e.target === panel) panel.className = ''; };
    var setup = document.createElement('div'); setup.id = 'jcpos-setup';
    document.body.appendChild(pill); document.body.appendChild(note); document.body.appendChild(panel); document.body.appendChild(setup);

    onStatus(function (s) {
      var t;
      if (!s.configured) t = '未設定';
      else if (s.authError) t = '設定が無効です';
      else if (s.failed) t = '⚠ 送信できなかった操作 ' + s.failed + '件';
      else if (s.syncing) t = '送信中…（残り' + s.pending + '件）';
      else if (s.pending) t = (s.online ? 'オンライン' : 'オフライン') + '・未送信 ' + s.pending + '件';
      else t = s.online ? 'オンライン' : 'オフライン';
      pill.querySelector('.txt').textContent = t;
      pill.className = (!s.online ? 'off ' : '') + ((s.failed || s.authError || !s.configured) ? 'err' : '');
    });

    // POS画面のカート欄（画面下に固定）と重ならないよう、その上に表示する
    var bar = document.querySelector('.cart-bar');
    if (bar) {
      var place = function () { document.documentElement.style.setProperty('--jcpos-pill-bottom', (bar.getBoundingClientRect().height + 8) + 'px'); };
      place();
      if (window.ResizeObserver) new ResizeObserver(place).observe(bar); else setInterval(place, 1000);
    }

    if (!cfg()) openSetup();
    else if (justConfigured) {
      notify('この端末の設定ができました');
      if (isIos() && !isStandalone()) openIosAfterSetup();
    }
  }

  function isIos() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function isStandalone() { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; }

  function openPanel() {
    var panel = document.getElementById('jcpos-panel');
    var q = queue(), fl = failed(), s = statusInfo();
    var synced = s.syncedAt ? new Date(s.syncedAt) : null;
    var h = '<div class="jcpos-box"><h3>通信と送信の状況</h3>' +
      '<div class="sub">状態：' + (s.online ? 'オンライン' : 'オフライン') + (synced ? '　最終同期：' + synced.toLocaleString('ja-JP') : '') + '</div>';
    h += '<h3 style="margin-top:14px;">未送信（自動で送ります）' + q.length + '件</h3>';
    h += q.length ? q.map(function (op) { return '<div class="jcpos-row">' + esc(op.at || '') + '　' + esc(opText(op)) + '</div>'; }).join('') : '<div class="sub">ありません</div>';
    h += '<h3 style="margin-top:14px;">送信できなかった操作 ' + fl.length + '件</h3>';
    if (fl.length) {
      h += '<div class="sub">別の端末で先に会計された等の理由で、サーバーが受け付けなかった操作です。内容を確認し、必要ならPOSで入力し直してから「確認済みにする」を押してください。</div>';
      h += fl.map(function (op) { return '<div class="jcpos-row">' + esc(op.at || '') + '　' + esc(opText(op)) + '<br><span class="er">理由：' + esc(op.error) + '</span></div>'; }).join('');
    } else h += '<div class="sub">ありません</div>';
    h += '<div class="jcpos-btns"><button class="pri" id="jcpos-sync">今すぐ送信</button>' +
      (fl.length ? '<button id="jcpos-retry">失敗分をもう一度送る</button><button id="jcpos-clear">確認済みにする</button>' : '') +
      '<button id="jcpos-close">閉じる</button></div>' +
      '<div class="jcpos-btns"><button id="jcpos-reset" style="font-size:12px;font-weight:400;">端末の設定をやり直す</button></div></div>';
    panel.innerHTML = h;
    panel.className = 'open';
    document.getElementById('jcpos-close').onclick = function () { panel.className = ''; };
    document.getElementById('jcpos-sync').onclick = function () {
      sync().then(function () { notify('送信しました'); openPanel(); }, function (e) { notify(e.offline ? 'オフラインのため送信できません' : e.message, true); });
    };
    var r = document.getElementById('jcpos-retry');
    if (r) r.onclick = function () {
      var f = failed(); setFailed([]);
      var qq = queue(); f.forEach(function (op) { delete op.error; delete op.failedAt; qq.push(op); }); setQueue(qq);
      sync().catch(function () {}).then(openPanel);
    };
    var c = document.getElementById('jcpos-clear');
    if (c) c.onclick = function () { setFailed([]); openPanel(); };
    document.getElementById('jcpos-reset').onclick = function () { panel.className = ''; openSetup(true); };
  }

  function openSetup(canCancel) {
    var el = document.getElementById('jcpos-setup');
    el.innerHTML = '<div class="jcpos-box"><h3>この端末の設定</h3>' +
      '<div class="sub">店のパソコンで「POSのウェブアプリURL<b>?mode=app</b>」を開き、管理者暗証番号を入れると設定用のQRとリンクが出ます。' +
      '<br>・Android：QRを読み取って開けば設定完了です。<br>・iPhone（ホーム画面のアプリ）：設定リンクをコピーして、下の欄に貼り付けてください。</div>' +
      '<textarea id="jcpos-setup-text" placeholder="設定リンクをここに貼り付け"></textarea>' +
      '<div class="jcpos-btns"><button class="pri" id="jcpos-setup-ok">設定する</button>' + (canCancel ? '<button id="jcpos-setup-cancel">やめる</button>' : '') + '</div></div>';
    el.className = 'open';
    document.getElementById('jcpos-setup-ok').onclick = function () {
      var c = parseSetup(document.getElementById('jcpos-setup-text').value);
      if (!c) { notify('設定リンクの形が正しくありません。もう一度コピーしてください', true); return; }
      LS.set('jc_cfg', c); status.authError = false;
      el.className = '';
      api('appPing', [], 15000).then(function () {
        notify('設定できました。データを読み込みます');
        setTimeout(function () { location.reload(); }, 800);
      }, function (e) { notify(e.offline ? '設定しました（今はオフラインです）' : '設定できませんでした：' + e.message, !e.offline); emitStatus(); });
    };
    var cc = document.getElementById('jcpos-setup-cancel');
    if (cc) cc.onclick = function () { el.className = ''; };
  }

  // iPhone：Safari とホーム画面のアプリは保存場所が別なので、追加したアプリでもう一度貼り付けてもらう
  function openIosAfterSetup() {
    var el = document.getElementById('jcpos-setup');
    var link = location.origin + location.pathname + '#setup=' + encodeURIComponent(JSON.stringify(cfg()));
    el.innerHTML = '<div class="jcpos-box"><h3>iPhone のホーム画面に追加</h3>' +
      '<div class="sub">1.「設定リンクをコピー」を押す<br>2. Safari の共有ボタン →「ホーム画面に追加」<br>3. ホーム画面の「JC POS」を開き、出てくる欄に貼り付けて「設定する」<br><br>（iPhone は Safari とホーム画面のアプリで保存場所が分かれているため、最初に一度だけ貼り付けが必要です）</div>' +
      '<div class="jcpos-btns"><button class="pri" id="jcpos-copy">設定リンクをコピー</button><button id="jcpos-later">このままSafariで使う</button></div></div>';
    el.className = 'open';
    document.getElementById('jcpos-copy').onclick = function () {
      var done = function () { notify('コピーしました。共有 →「ホーム画面に追加」へ'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, function () { prompt('このリンクをコピーしてください', link); });
      else prompt('このリンクをコピーしてください', link);
    };
    document.getElementById('jcpos-later').onclick = function () { el.className = ''; };
  }

  function onStatus(f) { statusCbs.push(f); f(statusInfo()); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectUi);
  else injectUi();

  // 起動時：送信待ちがあれば送る
  if (cfg() && queue().length) schedule(1500);

  return {
    call: call, sync: sync, status: statusInfo, onStatus: onStatus, notify: notify,
    queue: queue, failed: failed, localView: localView, configured: function () { return !!cfg(); }
  };
})();

// 送信が終わったら未精算の表示を最新に（POS画面）
window.addEventListener('jcpos:synced', function () {
  if (typeof window.refreshAllTableUnpaid === 'function') { try { window.refreshAllTableUnpaid(); } catch (e) {} }
});
// 複数端末で使うため、他の端末の注文も定期的に反映（POS画面・表示中のみ）
setInterval(function () {
  if (document.hidden || !JCPOS.configured() || typeof window.refreshAllTableUnpaid !== 'function') return;
  if (document.querySelector('.modal-overlay:not(.hidden)')) return; // 入力中は邪魔しない
  try { window.refreshAllTableUnpaid(); } catch (e) {}
}, 20000);

// オフラインでも開けるように Service Worker を登録＋自動更新
// ・起動時／画面に戻った時／15分ごとに新しい版があるか確認する
// ・新しい版が届いたら、操作中でないタイミング（モーダルが閉じていて、カートが空で、会計処理中でない）に自動で再読み込み
// ・送信待ちの注文は端末に保存されているので、再読み込みしても消えない
(function () {
  if (!('serviceWorker' in navigator)) return;
  var hadController = !!navigator.serviceWorker.controller; // 初回インストール時は再読み込みしない
  var updateReady = false, reloading = false, reg = null;

  function isBusy() {
    if (document.querySelector('.modal-overlay:not(.hidden)')) return true;
    try { if (typeof cart !== 'undefined' && cart && Object.keys(cart).length) return true; } catch (e) {}
    try { if (typeof checkoutInFlight !== 'undefined' && checkoutInFlight) return true; } catch (e) {}
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.value) return true;
    return false;
  }
  function doReload() { if (reloading) return; reloading = true; location.reload(); }
  function showBanner() {
    if (document.getElementById('jcpos-update')) return;
    var b = document.createElement('div');
    b.id = 'jcpos-update';
    b.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;background:#4a2f1f;color:#fff;padding:10px 14px;border-radius:12px;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.25);display:flex;gap:10px;align-items:center;';
    b.innerHTML = '<span>新しいバージョンがあります。操作が終わると自動で更新します</span><button type="button" style="background:#c8672c;color:#fff;border:none;border-radius:8px;padding:6px 12px;font-weight:700;">今すぐ更新</button>';
    b.querySelector('button').onclick = doReload;
    document.body.appendChild(b);
  }
  function tryApply() {
    if (!updateReady || reloading) return;
    if (!isBusy()) doReload(); else showBanner();
  }
  function checkUpdate() { if (reg && navigator.onLine !== false) reg.update().catch(function () {}); }

  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController) { hadController = true; return; }
    updateReady = true;
    tryApply();
  });

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (r) {
      reg = r;
      checkUpdate();
    }).catch(function () {});
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) checkUpdate(); });
  window.addEventListener('online', checkUpdate);
  setInterval(checkUpdate, 15 * 60 * 1000);
  setInterval(tryApply, 5000); // 更新待ちの間、操作が終わったか5秒ごとに確認
})();
