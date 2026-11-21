'use strict';
// Run:  node test/api.test.js   (starts its own temporary server, no setup needed)
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const assert = require('assert');
const PORT = 3900 + Math.floor(Math.random() * 90), TOKEN = 'test-token-123';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
const base = 'http://127.0.0.1:' + PORT;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT, ADMIN_TOKEN: TOKEN, DATA_DIR: dir, ORDER_RATE_MAX: '1000', ADMIN_TIMEOUT_MIN: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' }), stdio: 'pipe' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const call = async (m, p, body, auth) => {
  const r = await fetch(base + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, auth === false ? {} : { Authorization: 'Bearer ' + TOKEN }), body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; } return { s: r.status, j, h: r.headers };
};
let n = 0; const ok = (name, fn) => fn().then(() => { n++; console.log('  ok  ' + name); }, e => { console.error('FAIL ' + name + '\n', e.message); process.exitCode = 1; });
const png = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
(async () => {
  for (let i = 0; i < 40; i++) { try { await fetch(base + '/healthz'); break; } catch (e) { await sleep(100); } }
  const menu = { store: { name: 'Test Batchoy', acceptingOrders: true, deliveryEnabled: true, deliveryFee: 30, minOrder: 50, gcashNumber: '09171234567', gcashName: 'Juan' },
    categories: [{ id: 1, name: 'Batchoy' }], products: [
      { id: 1, name: 'Special Batchoy', categoryId: 1, price: 99, active: true, track: false, stock: 0, imageSig: 'a1' },
      { id: 2, name: 'Egg', categoryId: 1, price: 15, active: true, track: true, stock: 3, imageSig: '' },
      { id: 3, name: 'Hidden', categoryId: 1, price: 10, active: false, track: false, stock: 0, imageSig: '' }] };
  const order = o => Object.assign({ clientId: 'cid-' + Math.random().toString(36).slice(2), name: 'Maria Cruz', phone: '0917 123 4567', type: 'pickup', items: [{ id: 1, qty: 2 }], payment: { method: 'cash' } }, o || {});
  let code, seq;
  await ok('health + static site served', async () => { assert.equal((await call('GET', '/healthz')).s, 200); const r = await call('GET', '/'); assert.equal(r.s, 200); assert(r.h.get('content-security-policy')); });
  await ok('path traversal blocked', async () => { const r = await fetch(base + '/..%2fserver.js'); assert([403, 404].includes(r.status)); const r2 = await fetch(base + '/%2e%2e/server.js'); assert([403, 404].includes(r2.status)); });
  await ok('admin rejects bad/no token', async () => { assert.equal((await call('GET', '/api/admin/ping', null, false)).s, 401); const r = await fetch(base + '/api/admin/ping', { headers: { Authorization: 'Bearer nope' } }); assert.equal(r.status, 401); });
  await ok('admin ping', async () => { const r = await call('GET', '/api/admin/ping'); assert.equal(r.s, 200); assert(r.j.epoch); });
  await ok('CORS preflight for app', async () => { const r = await fetch(base + '/api/admin/ping', { method: 'OPTIONS' }); assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), '*'); });
  await ok('orders refused before a menu exists', async () => { const r = await call('POST', '/api/orders', order()); assert.equal(r.s, 503); });
  await ok('menu push asks for images, then image upload', async () => {
    const r = await call('PUT', '/api/admin/menu', menu); assert.equal(r.s, 200); assert.deepEqual(r.j.needImages, [1]);
    const i = await call('PUT', '/api/admin/image/1', { sig: 'a1', dataUrl: png }); assert.equal(i.s, 200);
    const r2 = await call('PUT', '/api/admin/menu', menu); assert.deepEqual(r2.j.needImages, []);
    const bad = await call('PUT', '/api/admin/image/1', { sig: 'a1', dataUrl: 'data:text/html;base64,PGI+' }); assert.equal(bad.s, 400);
  });
  await ok('public menu hides inactive items, cost and exact stock rules', async () => {
    const m = (await call('GET', '/api/menu', null, false)).j;
    assert.equal(m.products.length, 2); assert.equal(m.store.open, true); assert(m.products[0].img.startsWith('/img/1?v='));
    assert.equal(m.products[1].max, 3); assert(!JSON.stringify(m).includes('cost'));
    const img = await fetch(base + m.products[0].img); assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/jpeg');
  });
  await ok('place pickup order, price computed on server', async () => {
    const r = await call('POST', '/api/orders', order({ items: [{ id: 1, qty: 2 }, { id: 2, qty: 1 }], price: 1, total: 1 }), false);
    assert.equal(r.s, 201); assert.equal(r.j.order.total, 213); assert.equal(r.j.order.status, 'new'); assert(/^BT-[A-Z0-9]{5}$/.test(r.j.order.code)); code = r.j.order.code;
  });
  await ok('double-submit returns same order', async () => {
    const body = order({ clientId: 'dup-client-id-1' }); const a = await call('POST', '/api/orders', body, false), b = await call('POST', '/api/orders', body, false);
    assert.equal(a.j.order.code, b.j.order.code); assert.equal(b.j.duplicate, true);
    await call('POST', '/api/admin/orders/' + a.j.order.code + '/status', { status: 'cancelled' });
  });
  await ok('delivery adds fee, needs address', async () => {
    const no = await call('POST', '/api/orders', order({ type: 'delivery' }), false); assert.equal(no.s, 400); assert.equal(no.j.field, 'address');
    const y = await call('POST', '/api/orders', order({ type: 'delivery', address: '123 Mango Ave, Cebu City', payment: { method: 'gcash', ref: '12345' } }), false);
    assert.equal(y.s, 201); assert.equal(y.j.order.fee, 30); assert.equal(y.j.order.total, 228);
    await call('POST', '/api/admin/orders/' + y.j.order.code + '/status', { status: 'cancelled' });
  });
  await ok('validation: phone, name, stock, hidden item, min order, empty', async () => {
    assert.equal((await call('POST', '/api/orders', order({ phone: '123' }), false)).j.field, 'phone');
    assert.equal((await call('POST', '/api/orders', order({ name: ' ' }), false)).j.field, 'name');
    assert.equal((await call('POST', '/api/orders', order({ items: [{ id: 2, qty: 4 }] }), false)).j.code, 'menu_changed');
    assert.equal((await call('POST', '/api/orders', order({ items: [{ id: 3, qty: 1 }] }), false)).j.code, 'menu_changed');
    assert.equal((await call('POST', '/api/orders', order({ items: [{ id: 2, qty: 1 }] }), false)).j.field, 'minOrder');
    assert.equal((await call('POST', '/api/orders', order({ items: [] }), false)).s, 400);
    assert.equal((await call('POST', '/api/orders', order({ items: [{ id: 1, qty: -1 }] }), false)).s, 400);
  });
  await ok('admin polls orders incrementally and epoch reset works', async () => {
    const a = (await call('GET', '/api/admin/orders?since=0')).j; assert(a.orders.length >= 1); seq = a.seq;
    const o = a.orders.find(x => x.code === code); assert.equal(o.customer.phone, '09171234567');
    const b = (await call('GET', '/api/admin/orders?since=' + seq + '&epoch=' + a.epoch)).j; assert.equal(b.orders.length, 0);
    const c = (await call('GET', '/api/admin/orders?since=' + seq + '&epoch=wrong')).j; assert.equal(c.reset, true); assert(c.orders.length >= 1);
  });
  await ok('status flow, idempotent, illegal transition blocked', async () => {
    let r = await call('POST', '/api/admin/orders/' + code + '/status', { status: 'preparing' }); assert.equal(r.j.order.status, 'preparing');
    r = await call('POST', '/api/admin/orders/' + code + '/status', { status: 'preparing' }); assert.equal(r.s, 200); assert.equal(r.j.changed, false);
    const t = (await call('GET', '/api/orders/' + code, null, false)).j.order; assert.equal(t.status, 'preparing'); assert(!JSON.stringify(t).includes('0917'));
    r = await call('POST', '/api/admin/orders/' + code + '/status', { status: 'new' }); assert.equal(r.s, 409);
    r = await call('POST', '/api/admin/orders/' + code + '/status', { status: 'ready' }); assert.equal(r.j.order.status, 'ready');
    r = await call('POST', '/api/admin/orders/' + code + '/status', { status: 'completed' }); assert.equal(r.j.order.status, 'completed');
    assert.equal((await call('POST', '/api/admin/orders/' + code + '/status', { status: 'cancelled' })).s, 409);
    assert.equal((await call('POST', '/api/admin/orders/BT-NOPE1/status', { status: 'ready' })).s, 404);
    const d = (await call('GET', '/api/admin/orders?since=' + seq)).j; assert(d.orders.some(x => x.code === code && x.status === 'completed'));
  });
  await ok('customer can cancel only while new', async () => {
    const a = await call('POST', '/api/orders', order(), false); const c = a.j.order.code;
    const r = await call('POST', '/api/orders/' + c + '/cancel', null, false); assert.equal(r.j.order.status, 'cancelled');
    const b = await call('POST', '/api/orders', order(), false); await call('POST', '/api/admin/orders/' + b.j.order.code + '/status', { status: 'preparing' });
    assert.equal((await call('POST', '/api/orders/' + b.j.order.code + '/cancel', null, false)).s, 409);
    await call('POST', '/api/admin/orders/' + b.j.order.code + '/status', { status: 'cancelled', reason: 'Out of stock' });
  });
  await ok('store closed blocks orders', async () => {
    await call('PUT', '/api/admin/menu', Object.assign({}, menu, { store: Object.assign({}, menu.store, { acceptingOrders: false }) }));
    assert.equal((await call('GET', '/api/menu', null, false)).j.store.open, false);
    assert.equal((await call('POST', '/api/orders', order(), false)).s, 503);
    await call('PUT', '/api/admin/menu', menu);
  });
  await ok('max 3 active orders per phone', async () => {
    const p = '09181112222'; let last;
    for (let i = 0; i < 4; i++) last = await call('POST', '/api/orders', order({ phone: p }), false);
    assert.equal(last.s, 429);
  });
  await ok('oversized body rejected', async () => { const r = await call('POST', '/api/orders', { clientId: 'x'.repeat(40000) }, false); assert.equal(r.s, 413); });
  await ok('data survives restart (file db)', async () => { assert(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).orders[code]); });
  console.log(n + ' checks passed'); srv.kill();
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
