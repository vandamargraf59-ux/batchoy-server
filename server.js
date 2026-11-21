'use strict';
/*
 * Batchoyan de Lapaz — Online Order Server
 * Zero dependencies. Requires Node.js 18 or newer.
 *
 *   Customers  -> open the site, browse the menu, place an order
 *   POS app    -> pushes the menu here, polls for new orders, updates their status
 *   Telegram   -> (optional) instant phone alert for every new order, even if the app is closed
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------ config */
const env = process.env;
const PORT = Number(env.PORT) || 3000;
const ADMIN_TOKEN = String(env.ADMIN_TOKEN || '');
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const IMG_DIR = path.join(DATA_DIR, 'img');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TRUST_PROXY = /^(1|true|yes)$/i.test(env.TRUST_PROXY || '');
const TG_TOKEN = String(env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT = String(env.TELEGRAM_CHAT_ID || '').trim();
const TG_ON = !!(TG_TOKEN && TG_CHAT);
const RETENTION_DAYS = Math.max(1, Number(env.RETENTION_DAYS) || 14);
/* Minutes without any contact from the POS app before the site stops taking orders (0 = never).
   Default: 15 min, or "never" when Telegram alerts are on (you get pinged even if the app is closed). */
const ADMIN_TIMEOUT_MIN = env.ADMIN_TIMEOUT_MIN !== undefined && env.ADMIN_TIMEOUT_MIN !== ''
  ? Math.max(0, Number(env.ADMIN_TIMEOUT_MIN) || 0) : (TG_ON ? 0 : 15);
const ORDER_RATE_MAX = Math.max(1, Number(env.ORDER_RATE_MAX) || 20);
const PUBLIC_URL = String(env.PUBLIC_URL || '').replace(/\/+$/, '');

if (ADMIN_TOKEN.length < 8) {
  console.error('\n[!] ADMIN_TOKEN is missing or too short (min 8 characters).\n    Example:  ADMIN_TOKEN=my-secret-password node server.js\n');
  process.exit(1);
}

const STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled'];
const ACTIVE = ['new', 'preparing', 'ready'];
const NEXT = {
  new: ['preparing', 'ready', 'completed', 'cancelled'],
  preparing: ['ready', 'completed', 'cancelled'],
  ready: ['completed', 'cancelled'],
  completed: [], cancelled: []
};

/* ------------------------------------------------------------------ storage */
fs.mkdirSync(IMG_DIR, { recursive: true });
let db = { epoch: crypto.randomBytes(8).toString('hex'), seq: 0, orders: {}, menu: null, lastAdminSeen: 0 };
try {
  if (fs.existsSync(DB_FILE)) {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (d && typeof d === 'object' && d.epoch) db = Object.assign(db, d);
  }
} catch (e) {
  const bad = DB_FILE + '.corrupt-' + Date.now();
  try { fs.copyFileSync(DB_FILE, bad); } catch (e2) { /* ignore */ }
  console.error('[!] db.json could not be read (' + e.message + '). A copy was saved to ' + bad + '. Starting fresh.');
}
if (!db.orders || typeof db.orders !== 'object') db.orders = {};

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
if (!fs.existsSync(DB_FILE)) save();

/* ------------------------------------------------------------------ helpers */
const now = () => Date.now();
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const isStr = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max;
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const peso = n => 'PHP ' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function clientIp(req) {
  if (TRUST_PROXY) {
    const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (x) return x;
  }
  return req.socket.remoteAddress || 'unknown';
}
const hits = new Map();
function limited(key, max, windowMs) {
  const t = now(), arr = (hits.get(key) || []).filter(x => t - x < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(t); hits.set(key, arr); return false;
}
setInterval(() => { const t = now(); for (const [k, v] of hits) { if (!v.length || t - v[v.length - 1] > 3600000) hits.delete(k); } }, 600000).unref();

function newCode() {
  const A = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  for (let n = 0; n < 50; n++) {
    let c = 'BT-';
    for (let i = 0; i < 5; i++) c += A[crypto.randomInt(A.length)];
    if (!db.orders[c]) return c;
  }
  throw new Error('could not generate order code');
}
function normPhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (/^\+?63\d{10}$/.test(d)) d = '0' + d.replace(/^\+?63/, '');
  else if (/^9\d{9}$/.test(d)) d = '0' + d;
  d = d.replace(/\D/g, '');
  return d.length >= 7 && d.length <= 15 ? d : '';
}

/* ------------------------------------------------------------------ http plumbing */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8', '.ico': 'image/png', '.webmanifest': 'application/manifest+json'
};
function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }, headers || {}));
  res.end(body);
}
function json(res, code, obj, extra) {
  send(res, code, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
}
const fail = (res, code, error, errCode, extra) => json(res, code, Object.assign({ error, code: errCode || 'error' }, extra || {}));
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, dead = false; const chunks = [];
    req.on('data', c => {
      if (dead) return;
      size += c.length;
      if (size > limit) { dead = true; chunks.length = 0; reject(Object.assign(new Error('Request too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (dead) return;
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Max-Age': '86400'
};
const SITE_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/* ------------------------------------------------------------------ telegram */
async function notify(text) {
  if (!TG_ON) return false;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true })
    });
    if (!r.ok) { console.error('[telegram] HTTP ' + r.status + ' ' + (await r.text().catch(() => ''))); return false; }
    return true;
  } catch (e) { console.error('[telegram] ' + e.message); return false; }
  finally { clearTimeout(timer); }
}
function orderText(o, head) {
  const lines = [head + ' ' + o.code, '',
    o.customer.name + ' - ' + o.customer.phone,
    (o.type === 'delivery' ? 'DELIVERY: ' + o.address : 'PICK-UP')];
  o.items.forEach(i => lines.push(i.qty + ' x ' + i.name));
  if (o.fee) lines.push('Delivery fee: ' + peso(o.fee));
  lines.push('TOTAL: ' + peso(o.total));
  lines.push('Payment: ' + (o.payment.method === 'gcash' ? 'GCash' + (o.payment.ref ? ' (ref ' + o.payment.ref + ')' : '') : 'Cash'));
  if (o.note) lines.push('Note: ' + o.note);
  lines.push('', 'Open the Batchoyan POS app > Online tab' + (PUBLIC_URL ? '' : '.'));
  return lines.join('\n');
}

/* ------------------------------------------------------------------ menu / store state */
function storeCfg() { return (db.menu && db.menu.store) || {}; }
function adminPresent() {
  if (!ADMIN_TIMEOUT_MIN) return true;
  return db.lastAdminSeen > 0 && now() - db.lastAdminSeen <= ADMIN_TIMEOUT_MIN * 60000;
}
function openState() {
  if (!db.menu || !db.menu.products || !db.menu.products.length) return { open: false, reason: 'nomenu' };
  if (storeCfg().acceptingOrders === false) return { open: false, reason: 'closed' };
  if (!adminPresent()) return { open: false, reason: 'offline' };
  return { open: true, reason: '' };
}
const imgUrl = p => '/img/' + p.id + '?v=' + crypto.createHash('sha1').update(String(p.imageSig)).digest('hex').slice(0, 10);
function publicMenu() {
  const m = db.menu || { store: {}, categories: [], products: [] }, s = m.store || {}, st = openState();
  return {
    store: {
      name: s.name || 'Batchoyan de Lapaz', address: s.address || '', phone: s.phone || '', note: s.note || '',
      open: st.open, closedReason: st.reason,
      deliveryEnabled: !!s.deliveryEnabled, deliveryFee: r2(s.deliveryFee || 0), minOrder: r2(s.minOrder || 0),
      gcashEnabled: !!(s.gcashNumber), gcashNumber: s.gcashNumber || '', gcashName: s.gcashName || ''
    },
    categories: (m.categories || []).map(c => ({ id: c.id, name: c.name })),
    products: (m.products || []).filter(p => p.active !== false).map(p => ({
      id: p.id, name: p.name, categoryId: p.categoryId === '' ? null : p.categoryId, price: p.price,
      max: p.track ? Math.max(0, p.stock) : null, img: p.hasImage ? imgUrl(p) : null
    })),
    serverTime: now()
  };
}

/* ------------------------------------------------------------------ orders */
function touch(o) { o.seq = ++db.seq; o.updatedAt = now(); }
function publicOrder(o) {
  return {
    code: o.code, status: o.status, type: o.type, createdAt: o.createdAt, updatedAt: o.updatedAt, times: o.times,
    items: o.items, subtotal: o.subtotal, fee: o.fee, total: o.total, payment: { method: o.payment.method },
    name: o.customer.name.split(' ')[0], cancelReason: o.cancelReason || '', storeName: storeCfg().name || ''
  };
}
async function createOrder(req, res) {
  const ip = clientIp(req);
  if (limited('ord:' + ip, ORDER_RATE_MAX, 10 * 60000)) return fail(res, 429, 'Too many orders from this device. Please wait a few minutes.', 'rate');
  let b; try { b = await readBody(req, 32 * 1024); } catch (e) { return fail(res, e.status || 400, e.message, 'invalid'); }

  const st = openState();
  if (!st.open) {
    return fail(res, 503, st.reason === 'closed' ? "Sorry, we're not taking online orders right now." : 'Online ordering is temporarily unavailable. Please try again in a few minutes.', 'closed');
  }
  const s = storeCfg();
  const clientId = clean(b.clientId, 64);
  if (clientId.length < 8) return fail(res, 400, 'Invalid request. Please refresh the page and try again.', 'invalid');
  // idempotency: same cart submitted twice (double tap / retry) returns the same order
  for (const k in db.orders) { if (db.orders[k].clientId === clientId) return json(res, 200, { ok: true, duplicate: true, order: publicOrder(db.orders[k]) }); }

  const name = clean(b.name, 60), phone = normPhone(b.phone);
  if (name.length < 2) return fail(res, 400, 'Please enter your name.', 'invalid', { field: 'name' });
  if (!phone) return fail(res, 400, 'Please enter a valid mobile number.', 'invalid', { field: 'phone' });
  const type = b.type === 'delivery' ? 'delivery' : 'pickup';
  if (type === 'delivery' && !s.deliveryEnabled) return fail(res, 400, 'Delivery is not available right now. Please choose pick-up.', 'invalid', { field: 'type' });
  const address = type === 'delivery' ? clean(b.address, 200) : '';
  if (type === 'delivery' && address.length < 6) return fail(res, 400, 'Please enter your complete delivery address.', 'invalid', { field: 'address' });
  const method = b.payment && b.payment.method === 'gcash' ? 'gcash' : 'cash';
  if (method === 'gcash' && !s.gcashNumber) return fail(res, 400, 'GCash is not available. Please choose cash.', 'invalid', { field: 'payment' });
  const ref = method === 'gcash' ? clean(b.payment && b.payment.ref, 40) : '';
  const note = clean(b.note, 200);

  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 40) return fail(res, 400, 'Your order is empty.', 'invalid');
  const prods = new Map(((db.menu && db.menu.products) || []).map(p => [Number(p.id), p]));
  const merged = new Map();
  for (const it of b.items) {
    const id = Number(it && it.id), qty = Number(it && it.qty);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 50) return fail(res, 400, 'Invalid item quantity.', 'invalid');
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  const items = []; let subtotal = 0;
  for (const [id, qty] of merged) {
    const p = prods.get(id);
    if (!p || p.active === false) return fail(res, 409, 'An item in your cart is no longer available. Your cart has been updated.', 'menu_changed');
    if (p.track && qty > p.stock) return fail(res, 409, p.stock > 0 ? 'Only ' + p.stock + ' left of ' + p.name + '.' : p.name + ' is sold out.', 'menu_changed');
    items.push({ id, name: p.name, price: p.price, qty });
    subtotal += p.price * qty;
  }
  subtotal = r2(subtotal);
  if (s.minOrder && subtotal < s.minOrder) return fail(res, 400, 'The minimum order is ' + peso(s.minOrder) + '.', 'invalid', { field: 'minOrder' });
  const fee = type === 'delivery' ? r2(s.deliveryFee || 0) : 0, total = r2(subtotal + fee);
  if (total > 50000) return fail(res, 400, 'This order is too large to place online. Please call us.', 'invalid');

  let active = 0;
  for (const k in db.orders) { const o = db.orders[k]; if (ACTIVE.includes(o.status) && o.customer.phone === phone) active++; }
  if (active >= 3) return fail(res, 429, 'You already have 3 orders in progress. Please wait for them to finish.', 'rate');

  const t = now(), o = {
    code: newCode(), seq: 0, clientId, createdAt: t, updatedAt: t, status: 'new', times: { new: t },
    type, customer: { name, phone }, address, note, items, subtotal, fee, total, payment: { method, ref }, cancelReason: ''
  };
  touch(o); db.orders[o.code] = o; save();
  console.log('[order] ' + o.code + ' ' + o.type + ' ' + peso(o.total));
  notify(orderText(o, 'NEW ONLINE ORDER'));
  json(res, 201, { ok: true, order: publicOrder(o) });
}
function setStatus(o, status, reason) {
  if (o.status === status) return true;
  if (!NEXT[o.status].includes(status)) return false;
  o.status = status; o.times[status] = now();
  if (status === 'cancelled') o.cancelReason = clean(reason, 120);
  touch(o); save();
  return true;
}

/* ------------------------------------------------------------------ images */
function sanitizeProducts(list) {
  const out = [], seen = new Set();
  for (const p of Array.isArray(list) ? list.slice(0, 500) : []) {
    const id = Number(p && p.id);
    if (!Number.isInteger(id) || id < 1 || seen.has(id)) continue;
    seen.add(id);
    const price = Number(p.price);
    out.push({
      id, name: clean(p.name, 80) || 'Item', categoryId: p.categoryId === '' || p.categoryId == null ? '' : Number(p.categoryId) || '',
      price: isFinite(price) && price >= 0 ? r2(price) : 0, active: p.active !== false, track: !!p.track,
      stock: p.track ? Math.max(0, Math.floor(Number(p.stock) || 0)) : 0, imageSig: p.imageSig ? clean(p.imageSig, 120) : ''
    });
  }
  return out;
}
const imgFile = id => path.join(IMG_DIR, String(id));
function dropImage(id) { try { fs.unlinkSync(imgFile(id)); } catch (e) { /* none */ } }
function putMenu(b) {
  const s = b.store && typeof b.store === 'object' ? b.store : {};
  const store = {
    name: clean(s.name, 60) || 'Batchoyan de Lapaz', address: clean(s.address, 160), phone: clean(s.phone, 30), note: clean(s.note, 200),
    acceptingOrders: s.acceptingOrders !== false, deliveryEnabled: !!s.deliveryEnabled,
    deliveryFee: Math.max(0, r2(Number(s.deliveryFee) || 0)), minOrder: Math.max(0, r2(Number(s.minOrder) || 0)),
    gcashNumber: clean(s.gcashNumber, 20), gcashName: clean(s.gcashName, 60)
  };
  const categories = (Array.isArray(b.categories) ? b.categories.slice(0, 100) : []).map(c => ({ id: Number(c && c.id), name: clean(c && c.name, 40) })).filter(c => Number.isInteger(c.id) && c.name);
  const products = sanitizeProducts(b.products);
  const old = new Map(((db.menu && db.menu.products) || []).map(p => [p.id, p]));
  const need = [];
  for (const p of products) {
    const o = old.get(p.id), have = o && o.hasImage && o.imageSig === p.imageSig && fs.existsSync(imgFile(p.id));
    p.hasImage = !!have; p.imgMime = have ? o.imgMime : '';
    if (p.imageSig && !have) need.push(p.id);
    if (!p.imageSig) dropImage(p.id);
  }
  for (const id of old.keys()) if (!products.some(p => p.id === id)) dropImage(id);
  db.menu = { store, categories, products, updatedAt: now() };
  save();
  return need;
}
function putImage(id, b) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl || ''));
  if (!m) return 'Unsupported image';
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 2 * 1024 * 1024) return 'Image too large';
  const p = ((db.menu && db.menu.products) || []).find(x => x.id === id);
  if (!p) return 'Unknown product';
  const tmp = imgFile(id) + '.tmp';
  fs.writeFileSync(tmp, buf); fs.renameSync(tmp, imgFile(id));
  p.hasImage = true; p.imgMime = m[1]; p.imageSig = clean(b.sig, 120) || p.imageSig || String(buf.length);
  save();
  return '';
}

/* ------------------------------------------------------------------ routing */
function authed(req, res) {
  const ip = clientIp(req), h = String(req.headers.authorization || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const failures = (hits.get('bad:' + ip) || []).filter(x => now() - x < 60000);
  if (failures.length >= 10) { fail(res, 429, 'Too many attempts. Try again in a minute.', 'rate'); return false; }
  if (!tok || !safeEqual(tok, ADMIN_TOKEN)) { failures.push(now()); hits.set('bad:' + ip, failures); fail(res, 401, 'Wrong admin token.', 'auth'); return false; }
  db.lastAdminSeen = now();
  return true;
}

async function admin(req, res, url, parts) {
  if (!authed(req, res)) return;
  const sub = parts[2], method = req.method;
  if (sub === 'ping' && method === 'GET') {
    return json(res, 200, { ok: true, epoch: db.epoch, seq: db.seq, serverTime: now(), telegram: TG_ON, adminTimeoutMin: ADMIN_TIMEOUT_MIN, hasMenu: !!db.menu, version: 1 });
  }
  if (sub === 'telegram-test' && method === 'POST') {
    if (!TG_ON) return fail(res, 400, 'Telegram is not set up on the server (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).', 'telegram');
    const ok = await notify('Test alert from your Batchoyan order server. If you can read this, new-order alerts will reach you.');
    return ok ? json(res, 200, { ok: true }) : fail(res, 502, 'Telegram did not accept the message. Check the bot token and chat id.', 'telegram');
  }
  if (sub === 'orders' && method === 'GET' && parts.length === 3) {
    let since = Math.max(0, Math.floor(Number(url.searchParams.get('since')) || 0)), reset = false;
    const ep = url.searchParams.get('epoch');
    if (ep && ep !== db.epoch) { since = 0; reset = true; }
    if (since > db.seq) { since = 0; reset = true; }
    const all = Object.values(db.orders).filter(o => o.seq > since).sort((a, c) => a.seq - c.seq);
    const page = all.slice(0, 200);
    return json(res, 200, { epoch: db.epoch, seq: page.length ? page[page.length - 1].seq : Math.max(since, 0) || 0, headSeq: db.seq, more: all.length > page.length, reset, orders: page });
  }
  if (sub === 'orders' && method === 'POST' && parts.length === 5 && parts[4] === 'status') {
    const o = db.orders[decodeURIComponent(parts[3])];
    if (!o) return fail(res, 404, 'Order not found on the server.', 'notfound');
    let b; try { b = await readBody(req, 4096); } catch (e) { return fail(res, e.status || 400, e.message, 'invalid'); }
    if (!STATUSES.includes(b.status)) return fail(res, 400, 'Unknown status.', 'invalid');
    const prev = o.status;
    if (!setStatus(o, b.status, b.reason)) return fail(res, 409, 'This order is already ' + o.status + '.', 'transition', { order: o });
    return json(res, 200, { ok: true, order: o, changed: prev !== o.status });
  }
  if (sub === 'menu' && method === 'PUT') {
    let b; try { b = await readBody(req, 1024 * 1024); } catch (e) { return fail(res, e.status || 400, e.message, 'invalid'); }
    return json(res, 200, { ok: true, needImages: putMenu(b), updatedAt: db.menu.updatedAt });
  }
  if (sub === 'image' && method === 'PUT' && parts.length === 4) {
    const id = Number(parts[3]);
    if (!Number.isInteger(id) || id < 1) return fail(res, 400, 'Bad product id.', 'invalid');
    let b; try { b = await readBody(req, 3 * 1024 * 1024); } catch (e) { return fail(res, e.status || 400, e.message, 'invalid'); }
    const err = putImage(id, b);
    return err ? fail(res, 400, err, 'invalid') : json(res, 200, { ok: true });
  }
  return fail(res, 404, 'Not found.', 'notfound');
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;
  if (parts[1] === 'admin') {
    if (method === 'OPTIONS') return send(res, 204, '', CORS);
    const origHead = res.writeHead.bind(res);
    res.writeHead = (c, h) => origHead(c, Object.assign({}, h || {}, CORS));
    return admin(req, res, url, parts);
  }
  if (parts[1] === 'menu' && method === 'GET' && parts.length === 2) return json(res, 200, publicMenu());
  if (parts[1] === 'orders' && method === 'POST' && parts.length === 2) return createOrder(req, res);
  if (parts[1] === 'orders' && parts.length === 3 && method === 'GET') {
    if (limited('track:' + clientIp(req), 120, 60000)) return fail(res, 429, 'Too many requests.', 'rate');
    const o = db.orders[decodeURIComponent(parts[2]).toUpperCase()];
    return o ? json(res, 200, { order: publicOrder(o) }) : fail(res, 404, 'We could not find that order.', 'notfound');
  }
  if (parts[1] === 'orders' && parts.length === 4 && parts[3] === 'cancel' && method === 'POST') {
    const o = db.orders[decodeURIComponent(parts[2]).toUpperCase()];
    if (!o) return fail(res, 404, 'We could not find that order.', 'notfound');
    if (o.status === 'cancelled') return json(res, 200, { ok: true, order: publicOrder(o) });
    if (o.status !== 'new') return fail(res, 409, 'The store already started on your order. Please call us to change it.', 'transition', { order: publicOrder(o) });
    setStatus(o, 'cancelled', 'Cancelled by customer');
    notify(orderText(o, 'ORDER CANCELLED BY CUSTOMER'));
    return json(res, 200, { ok: true, order: publicOrder(o) });
  }
  return fail(res, 404, 'Not found.', 'notfound');
}

function serveImage(res, url) {
  const id = Number(url.pathname.split('/')[2]);
  const p = ((db.menu && db.menu.products) || []).find(x => x.id === id);
  if (!p || !p.hasImage) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  fs.readFile(imgFile(id), (err, buf) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    send(res, 200, buf, { 'Content-Type': p.imgMime || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
  });
}
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const ext = path.extname(file).toLowerCase(), isHtml = ext === '.html';
    fs.readFile(file, (e2, buf) => {
      if (e2) return send(res, 500, 'Error', { 'Content-Type': 'text/plain' });
      const h = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=3600' };
      if (isHtml) h['Content-Security-Policy'] = SITE_CSP;
      send(res, 200, req.method === 'HEAD' ? '' : buf, h);
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/img/') && req.method === 'GET') return serveImage(res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
    return serveStatic(req, res, url);
  } catch (e) {
    console.error('[error]', e);
    if (!res.headersSent) fail(res, 500, 'Something went wrong on the server.', 'server'); else res.end();
  }
});

/* purge finished orders after RETENTION_DAYS (the POS app keeps its own permanent copy) */
function purge() {
  const cut = now() - RETENTION_DAYS * 86400000; let n = 0;
  for (const k in db.orders) { const o = db.orders[k]; if (!ACTIVE.includes(o.status) && o.updatedAt < cut) { delete db.orders[k]; n++; } }
  if (n) { save(); console.log('[purge] removed ' + n + ' old order(s)'); }
}
setInterval(purge, 3600000).unref();
purge();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('Batchoyan order server running on port ' + PORT);
    console.log(' - data folder : ' + DATA_DIR);
    console.log(' - telegram    : ' + (TG_ON ? 'ON' : 'off (optional)'));
    console.log(' - admin check : ' + (ADMIN_TIMEOUT_MIN ? 'site pauses if the POS app is silent for ' + ADMIN_TIMEOUT_MIN + ' min' : 'disabled'));
  });
  const stop = () => { try { save(); } catch (e) { /* ignore */ } process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
}
module.exports = { server, db: () => db };
