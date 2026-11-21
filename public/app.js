(function () {
'use strict';
/* Customer ordering page. All text is inserted with textContent (never innerHTML) so customer/menu data can't inject markup. */
var $ = function (s) { return document.querySelector(s); };
var peso = function (n) { return '\u20B1' + (Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 }); };
function h(tag, attrs) {
  var el = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function (k) {
    var v = attrs[k]; if (v == null || v === false) return;
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
    else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
  });
  (function add(list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i]; if (c == null || c === false) continue;
      if (Array.isArray(c)) add(c); else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  })(Array.prototype.slice.call(arguments, 2));
  return el;
}
function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
var toastT; function toast(m) { var t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2600); }

var M = null;                       // last menu from the server
var cart = store('bt_cart') || {};  // {productId: qty}
var cat = 'all', loadErr = false;
var cust = store('bt_cust') || { name: '', phone: '', address: '', type: 'pickup', method: 'cash' };
var track = store('bt_order');      // {code}
var tOrder = null;                  // last fetched order for tracking
var sheetKind = '';                 // 'cart' | 'track' | ''
var form = null;                    // checkout form state

/* ---------- api ---------- */
function api(path, opts) {
  opts = opts || {};
  var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 15000);
  return fetch(path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined, signal: ctl.signal, cache: 'no-store' })
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'Something went wrong. Please try again.'); e.status = r.status; e.data = j; throw e; } return j; }); },
      function () { throw Object.assign(new Error('No internet connection. Please check your signal and try again.'), { status: 0 }); })
    .finally(function () { clearTimeout(timer); });
}

/* ---------- menu ---------- */
function loadMenu() {
  return api('/api/menu').then(function (m) { M = m; loadErr = false; reconcileCart(); render(); }, function () { loadErr = true; render(); });
}
function prod(id) { return M && M.products.find(function (p) { return p.id === id; }); }
function reconcileCart() {
  var changed = false;
  Object.keys(cart).forEach(function (k) {
    var p = prod(Number(k));
    if (!p || p.max === 0) { delete cart[k]; changed = true; return; }
    if (p.max != null && cart[k] > p.max) { cart[k] = p.max; changed = true; }
  });
  saveCart(); return changed;
}
function saveCart() { store('bt_cart', cart); }
function cartCount() { return Object.keys(cart).reduce(function (a, k) { return a + cart[k]; }, 0); }
function subtotal() { return Object.keys(cart).reduce(function (a, k) { var p = prod(Number(k)); return a + (p ? p.price * cart[k] : 0); }, 0); }
function canOrder() { return !!(M && M.store.open); }
function setQty(id, d) {
  var p = prod(id); if (!p) return;
  var q = (cart[id] || 0) + d;
  if (p.max != null && q > p.max) { toast('Only ' + p.max + ' left'); return; }
  if (q > 50) { toast('Maximum 50 per item'); return; }
  if (q <= 0) delete cart[id]; else cart[id] = q;
  saveCart(); render(); if (sheetKind === 'cart') drawCart();
}

/* ---------- main render ---------- */
function closedMsg() {
  if (!M) return '';
  var r = M.store.closedReason;
  if (r === 'closed') return "We're closed for online orders right now. Please check back soon!";
  if (r === 'nomenu') return 'The menu is being set up. Please check back soon!';
  if (r === 'offline') return 'Online ordering is temporarily unavailable. Please try again in a few minutes.';
  return '';
}
function render() {
  var list = $('#list'), chips = $('#chips');
  if (!M) {
    list.replaceChildren(loadErr ? h('div', { class: 'empty' }, h('p', { text: 'Could not load the menu. Check your internet connection.' }), h('button', { class: 'btn sm', onclick: loadMenu, text: 'Try again' })) : h('div', { class: 'loading', text: 'Loading menu...' }));
    chips.replaceChildren(); return;
  }
  $('#sName').textContent = M.store.name; document.title = M.store.name + ' - Order Online';
  $('#sSub').textContent = M.store.address || 'Order online';
  var pill = $('#sPill'); pill.textContent = M.store.open ? 'Open' : 'Closed'; pill.className = 'pill ' + (M.store.open ? 'open' : 'closed');
  var b = $('#banner'), msg = M.store.open ? M.store.note : closedMsg();
  b.textContent = msg; b.className = 'banner' + (msg ? '' : ' hidden') + (M.store.open ? '' : ' bad');
  renderTrackBar();
  var cats = M.categories.filter(function (c) { return M.products.some(function (p) { return p.categoryId === c.id; }); });
  if (cat !== 'all' && !cats.some(function (c) { return c.id === cat; })) cat = 'all';
  chips.replaceChildren.apply(chips, [h('button', { class: 'chip' + (cat === 'all' ? ' on' : ''), onclick: function () { cat = 'all'; render(); }, text: 'All' })].concat(cats.map(function (c) {
    return h('button', { class: 'chip' + (cat === c.id ? ' on' : ''), onclick: function () { cat = c.id; render(); }, text: c.name });
  })));
  var sections = [];
  function group(title, items) {
    if (!items.length) return;
    if (title && cat === 'all') sections.push(h('div', { class: 'cat-h', text: title }));
    items.forEach(function (p) { sections.push(itemEl(p)); });
  }
  cats.forEach(function (c) { if (cat === 'all' || cat === c.id) group(c.name, M.products.filter(function (p) { return p.categoryId === c.id; })); });
  if (cat === 'all') group(cats.length ? 'Others' : '', M.products.filter(function (p) { return p.categoryId == null || !M.categories.some(function (c) { return c.id === p.categoryId; }); }));
  if (!sections.length) sections.push(h('div', { class: 'empty', text: 'No items to show yet.' }));
  var y = window.scrollY; list.replaceChildren.apply(list, sections); window.scrollTo(0, y);
  var n = cartCount(), bar = $('#cartBar'), bk = $('#basketBtn');
  bk.classList.toggle('hidden', !n); $('#basketN').textContent = n;
  if (n && !sheetKind) {
    bar.classList.remove('hidden');
    bar.replaceChildren(h('span', { class: 'n', text: String(n) }), h('span', { class: 'l', text: 'View my order' }), h('span', { text: peso(subtotal()) }));
  } else bar.classList.add('hidden');
}
function itemEl(p) {
  var out = p.max === 0, q = cart[p.id] || 0;
  var ctl;
  if (out) ctl = h('button', { class: 'add', disabled: true, text: 'Sold out' });
  else if (!q) ctl = h('button', { class: 'add', disabled: !canOrder(), onclick: function () { setQty(p.id, 1); }, text: 'Add' });
  else ctl = h('div', { class: 'step' }, h('button', { 'aria-label': 'Less', onclick: function () { setQty(p.id, -1); }, text: '\u2212' }), h('b', { text: String(q) }), h('button', { class: 'pl', 'aria-label': 'More', onclick: function () { setQty(p.id, 1); }, text: '+' }));
  return h('div', { class: 'item' + (out ? ' out' : '') },
    h('div', { class: 'ph' }, p.img ? h('img', { src: p.img, alt: '', loading: 'lazy' }) : '\uD83C\uDF5C'),
    h('div', { class: 'im' }, h('b', { text: p.name }), h('span', { class: 'pr', text: peso(p.price) }), p.max != null && p.max > 0 && p.max <= 5 ? h('small', { text: 'Only ' + p.max + ' left' }) : null),
    ctl);
}

/* ---------- sheets ---------- */
function openSheet(kind) { sheetKind = kind; $('#sheetBack').classList.remove('hidden'); document.body.style.overflow = 'hidden'; $('#cartBar').classList.add('hidden'); }
function closeSheet() { sheetKind = ''; $('#sheetBack').classList.add('hidden'); document.body.style.overflow = ''; render(); }
$('#sheetBack').addEventListener('mousedown', function (e) { if (e.target === this) closeSheet(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && sheetKind) closeSheet(); });
$('#cartBar').addEventListener('click', function () { openSheet('cart'); drawCart(); });
$('#basketBtn').addEventListener('click', function () { if (cartCount()) { openSheet('cart'); drawCart(); } });

function sheetShell(title, body, foot) {
  var s = $('#sheet');
  s.replaceChildren(h('div', { class: 'sh-h' }, h('h2', { text: title }), h('button', { class: 'x', 'aria-label': 'Close', onclick: closeSheet, text: '\u2715' })), h('div', { class: 'sh-b', id: 'shB' }, body), foot ? h('div', { class: 'sh-f' }, foot) : null);
}
function totals() {
  var sub = subtotal(), fee = cust.type === 'delivery' && M.store.deliveryEnabled ? M.store.deliveryFee : 0;
  return { sub: sub, fee: fee, total: sub + fee };
}
function drawCart() {
  if (!M) return;
  var ids = Object.keys(cart).map(Number);
  if (!ids.length) { sheetShell('Your order', h('div', { class: 'empty', text: 'Your order is empty.' }), h('button', { class: 'btn', onclick: closeSheet, text: 'Browse menu' })); return; }
  if (!M.store.deliveryEnabled && cust.type === 'delivery') cust.type = 'pickup';
  if (!M.store.gcashEnabled && cust.method === 'gcash') cust.method = 'cash';
  var keep = form || (form = { err: {}, busy: false, msg: '', cid: store('bt_cid') || ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)), ref: '', note: '' });
  store('bt_cid', keep.cid);
  var t = totals();
  var body = h('div', null,
    h('div', null, ids.map(function (id) {
      var p = prod(id); if (!p) return null;
      return h('div', { class: 'ci' }, h('div', { class: 'm' }, h('b', { text: p.name }), h('span', { text: peso(p.price) })),
        h('div', { class: 'step' }, h('button', { 'aria-label': 'Less', onclick: function () { setQty(id, -1); }, text: '\u2212' }), h('b', { text: String(cart[id]) }), h('button', { class: 'pl', 'aria-label': 'More', onclick: function () { setQty(id, 1); }, text: '+' })),
        h('div', { class: 'p', text: peso(p.price * cart[id]) }));
    })),
    h('div', { class: 'sec', text: 'How do you want it?' }),
    h('div', { class: 'seg' },
      h('button', { class: cust.type === 'pickup' ? 'on' : '', onclick: function () { cust.type = 'pickup'; keepForm(); drawCart(); }, text: 'Pick-up' }),
      M.store.deliveryEnabled ? h('button', { class: cust.type === 'delivery' ? 'on' : '', onclick: function () { cust.type = 'delivery'; keepForm(); drawCart(); }, text: 'Delivery' }) : null),
    cust.type === 'pickup' && M.store.address ? h('div', { class: 'hint', text: 'Pick up at: ' + M.store.address }) : null,
    field('name', 'Your name', 'input', { value: cust.name, maxlength: 60, autocomplete: 'name', placeholder: 'e.g. Maria Cruz' }),
    field('phone', 'Mobile number', 'input', { value: cust.phone, maxlength: 20, inputmode: 'tel', autocomplete: 'tel', placeholder: '09XX XXX XXXX' }),
    cust.type === 'delivery' ? field('address', 'Delivery address', 'textarea', { value: cust.address, maxlength: 200, placeholder: 'House no., street, barangay, landmark' }) : null,
    h('div', { class: 'sec', text: 'Payment' }),
    h('div', { class: 'seg' },
      h('button', { class: cust.method === 'cash' ? 'on' : '', onclick: function () { cust.method = 'cash'; keepForm(); drawCart(); }, text: cust.type === 'delivery' ? 'Cash on delivery' : 'Pay at the store' }),
      M.store.gcashEnabled ? h('button', { class: cust.method === 'gcash' ? 'on' : '', onclick: function () { cust.method = 'gcash'; keepForm(); drawCart(); }, text: 'GCash' }) : null),
    cust.method === 'gcash' ? h('div', null,
      h('div', { class: 'gbox' }, 'Send ', h('b', { text: peso(t.total) }), ' to GCash ', h('b', { text: M.store.gcashNumber }), M.store.gcashName ? ' (' + M.store.gcashName + ')' : '', '. Then type the reference number below.'),
      field('ref', 'GCash reference no. (optional)', 'input', { value: keep.ref, maxlength: 40, inputmode: 'numeric', placeholder: '13-digit reference' })) : null,
    field('note', 'Notes for the store (optional)', 'textarea', { value: keep.note, maxlength: 200, placeholder: 'e.g. no spring onions, extra spicy' }),
    h('div', { class: 'sum', style: 'margin-top:14px' },
      h('div', { class: 'row' }, h('span', { text: 'Subtotal' }), h('span', { text: peso(t.sub) })),
      t.fee ? h('div', { class: 'row' }, h('span', { text: 'Delivery fee' }), h('span', { text: peso(t.fee) })) : null,
      h('div', { class: 'row tot' }, h('span', { text: 'Total' }), h('span', { text: peso(t.total) }))),
    M.store.minOrder > 0 ? h('div', { class: 'hint', text: 'Minimum order: ' + peso(M.store.minOrder) }) : null,
    keep.msg ? h('div', { class: 'formerr', text: keep.msg }) : null);
  var below = M.store.minOrder > 0 && t.sub < M.store.minOrder;
  var btn = h('button', { class: 'btn', disabled: keep.busy || !canOrder() || below, onclick: placeOrder, text: keep.busy ? 'Placing order...' : !canOrder() ? 'Not accepting orders' : below ? 'Add ' + peso(M.store.minOrder - t.sub) + ' more' : 'Place order \u00B7 ' + peso(t.total) });
  var scroll = $('#shB') ? $('#shB').scrollTop : 0;
  sheetShell('Your order', body, btn);
  if ($('#shB')) $('#shB').scrollTop = scroll;
}
function field(key, label, tag, attrs) {
  var isCust = key === 'name' || key === 'phone' || key === 'address';
  var el = h(tag, Object.assign({ class: 'in' + (form.err[key] ? ' err' : ''), id: 'f_' + key }, attrs));
  if (tag === 'textarea') el.value = attrs.value || '';
  el.addEventListener('input', function () { if (isCust) cust[key] = el.value; else form[key] = el.value; el.classList.remove('err'); var e = el.parentNode.querySelector('.ferr'); if (e) e.remove(); store('bt_cust', cust); });
  return h('label', { class: 'fld' }, h('span', { text: label }), el, form.err[key] ? h('div', { class: 'ferr', text: form.err[key] }) : null);
}
function keepForm() { store('bt_cust', cust); }

function validate() {
  var e = {};
  if (cust.name.trim().length < 2) e.name = 'Please enter your name.';
  var d = cust.phone.replace(/[^\d+]/g, '').replace(/^\+?63(?=\d{10}$)/, '0').replace(/^9(?=\d{9}$)/, '09').replace(/\D/g, '');
  if (d.length < 7 || d.length > 15) e.phone = 'Please enter a valid mobile number.';
  if (cust.type === 'delivery' && cust.address.trim().length < 6) e.address = 'Please enter your complete address.';
  return e;
}
function placeOrder() {
  if (form.busy) return;
  form.err = validate(); form.msg = '';
  if (Object.keys(form.err).length) { form.msg = 'Please fix the highlighted fields.'; drawCart(); var f = document.querySelector('.in.err'); if (f) f.focus(); return; }
  form.busy = true; drawCart();
  api('/api/orders', { method: 'POST', body: {
    clientId: form.cid, name: cust.name, phone: cust.phone, type: cust.type, address: cust.type === 'delivery' ? cust.address : '', note: form.note,
    payment: { method: cust.method, ref: cust.method === 'gcash' ? form.ref : '' },
    items: Object.keys(cart).map(function (k) { return { id: Number(k), qty: cart[k] }; })
  } }).then(function (r) {
    cart = {}; saveCart(); store('bt_cid', null); form = null;
    track = { code: r.order.code }; store('bt_order', track); tOrder = r.order;
    drawTrack(); startPoll(); loadMenu();
  }, function (e) {
    form.busy = false; form.msg = e.message;
    if (e.data && e.data.field) form.err[e.data.field] = e.message;
    if (e.status === 409 || (e.data && (e.data.code === 'closed'))) loadMenu().then(function () { if (sheetKind === 'cart') drawCart(); });
    if (sheetKind === 'cart') drawCart();
  });
}

/* ---------- tracking ---------- */
var STEPS = { pickup: ['Order received', 'Preparing your order', 'Ready for pick-up', 'Picked up - enjoy!'], delivery: ['Order received', 'Preparing your order', 'Out for delivery', 'Delivered - enjoy!'] };
var IDX = { new: 0, preparing: 1, ready: 2, completed: 3 };
var HEAD = { new: 'Waiting for the store to confirm...', preparing: 'We are preparing your order', ready: null, completed: 'All done - salamat!', cancelled: 'Order cancelled' };
function tm(t) { return t ? new Date(t).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }) : ''; }
function isDone(o) { return !o || o.status === 'completed' || o.status === 'cancelled'; }
function drawTrack() {
  openSheet('track');
  var o = tOrder;
  if (!o) { sheetShell('Your order', h('div', { class: 'loading', text: 'Loading...' })); return; }
  var steps = STEPS[o.type] || STEPS.pickup, cur = IDX[o.status], head = HEAD[o.status] || (o.type === 'delivery' ? 'Your order is on the way!' : 'Your order is ready for pick-up!');
  var kids = [h('div', { class: 'done' }, h('div', { class: 'hint', text: 'Order number' }), h('div', { class: 'code', text: o.code }), h('div', { class: 'stat', text: head }))];
  if (o.status === 'cancelled') kids.push(h('div', { class: 'cancelled-box', text: o.cancelReason ? 'Reason: ' + o.cancelReason : 'This order was cancelled.' }));
  else kids.push(h('ol', { class: 'steps' }, steps.map(function (s, i) { return h('li', { class: i < cur || o.status === 'completed' ? 'on' : (i === cur ? 'cur' : '') }, s, i <= cur && o.times && o.times[['new', 'preparing', 'ready', 'completed'][i]] ? h('small', { text: tm(o.times[['new', 'preparing', 'ready', 'completed'][i]]) }) : null); })));
  kids.push(h('div', { class: 'sec', text: 'Your order' }));
  o.items.forEach(function (i) { kids.push(h('div', { class: 'ci' }, h('div', { class: 'm' }, h('b', { text: i.qty + ' x ' + i.name })), h('div', { class: 'p', text: peso(i.price * i.qty) }))); });
  if (o.fee) kids.push(h('div', { class: 'ci' }, h('div', { class: 'm' }, h('b', { text: 'Delivery fee' })), h('div', { class: 'p', text: peso(o.fee) })));
  kids.push(h('div', { class: 'ci' }, h('div', { class: 'm' }, h('b', { text: 'Total \u00B7 ' + (o.payment.method === 'gcash' ? 'GCash' : o.type === 'delivery' ? 'Cash on delivery' : 'Pay at the store') })), h('div', { class: 'p', text: peso(o.total) })));
  var foot = [];
  if (o.status === 'new') foot.push(h('button', { class: 'btn ghost sm', onclick: cancelOrder, text: 'Cancel order' }));
  foot.push(h('button', { class: 'btn' + (isDone(o) ? '' : ' ghost sm'), onclick: function () { if (isDone(o)) { track = null; store('bt_order', null); tOrder = null; } closeSheet(); }, text: isDone(o) ? 'Order again' : 'Back to menu' }));
  var s = $('#sheet'); var sc = $('#shB') ? $('#shB').scrollTop : 0;
  sheetShell('Track your order', h('div', null, kids), h('div', null, foot));
  if ($('#shB')) $('#shB').scrollTop = sc;
}
function cancelOrder() {
  if (!track || !confirm('Cancel this order?')) return;
  api('/api/orders/' + encodeURIComponent(track.code) + '/cancel', { method: 'POST' }).then(function (r) { tOrder = r.order; drawTrack(); }, function (e) { toast(e.message); pollOnce(); });
}
function renderTrackBar() {
  var b = $('#trackBar');
  if (!track || !tOrder || sheetKind) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  b.replaceChildren(h('small', { text: 'Your order ' + tOrder.code }), document.createTextNode(HEAD[tOrder.status] || (tOrder.type === 'delivery' ? 'Out for delivery' : 'Ready for pick-up') ), document.createTextNode(' \u203A'));
}
$('#trackBar').addEventListener('click', function () { drawTrack(); });
var pollT = null;
function pollOnce() {
  if (!track) return Promise.resolve();
  return api('/api/orders/' + encodeURIComponent(track.code)).then(function (r) {
    var changed = !tOrder || tOrder.status !== r.order.status || tOrder.updatedAt !== r.order.updatedAt;
    tOrder = r.order;
    if (changed) { if (sheetKind === 'track') drawTrack(); else renderTrackBar(); }
  }, function (e) { if (e.status === 404) { track = null; tOrder = null; store('bt_order', null); stopPoll(); if (sheetKind === 'track') closeSheet(); else render(); } });
}
function startPoll() { stopPoll(); pollT = setInterval(function () { if (document.hidden) return; if (isDone(tOrder) && tOrder) { stopPoll(); return; } pollOnce(); }, 5000); }
function stopPoll() { if (pollT) clearInterval(pollT); pollT = null; }
document.addEventListener('visibilitychange', function () { if (!document.hidden) { loadMenu(); if (track && !isDone(tOrder)) { pollOnce(); startPoll(); } } });
setInterval(function () { if (!document.hidden && !sheetKind) loadMenu(); }, 60000);

/* ---------- boot ---------- */
loadMenu();
if (track) { pollOnce().then(function () { renderTrackBar(); if (tOrder && !isDone(tOrder)) startPoll(); else if (tOrder && Date.now() - tOrder.updatedAt > 2 * 3600000) { track = null; tOrder = null; store('bt_order', null); render(); } }); }
})();
