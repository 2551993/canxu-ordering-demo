import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { publishDemoTunnel } from '../lib/demo-tunnel.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = join(root, 'runtime');

async function startServer(dataDir) {
  const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, PUBLIC_BASE_URL: '', SECURE_COOKIES: '0' };
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, windowsHide: true });
  const exited = once(child, 'exit');
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 5000);
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const port = output.match(/http:\/\/localhost:(\d+)/)?.[1];
      if (port) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${port}`);
      }
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error(output)));
    exited.finally(() => clearTimeout(timer)).catch(() => {});
  }).catch(async error => { child.kill(); await exited; throw error; });
  return {
    url,
    async stop() { child.kill(); await exited; },
    request(path, { method = 'GET', body, cookie, headers } = {}) {
      return new Promise((resolve, reject) => {
        const request = httpRequest(url + path, {
          method, signal: AbortSignal.timeout(5000),
          headers: { ...headers, ...(body && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }) },
        }, async response => {
          try {
            const chunks = [];
            for await (const chunk of response) chunks.push(chunk);
            const bytes = Buffer.concat(chunks);
            const setCookie = response.headers['set-cookie']?.[0];
            resolve({
              status: response.statusCode,
              location: response.headers.location,
              cookie: setCookie?.split(';')[0], setCookie,
              data: response.headers['content-type']?.includes('json') ? JSON.parse(bytes) : bytes,
            });
          } catch (error) { reject(error); }
        });
        request.on('error', reject);
        request.end(body ? JSON.stringify(body) : undefined);
      });
    },
  };
}

test('merchant accounts, menus, QR links, orders and sessions are isolated and persist in SQLite', async () => {
  mkdirSync(runtime, { recursive: true });
  const dataDir = mkdtempSync(join(runtime, 'multishop-test-'));
  let server;
  try {
    const { scryptSync } = await import('node:crypto');
    const salt = Buffer.alloc(16, 23);
    const oldPassword = 'test-legacy-pass';
    const oldPhone = '19900001111';
    const oldHash = scryptSync(oldPassword, salt, 64, { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
    writeFileSync(join(dataDir, 'store.json'), JSON.stringify({
      merchantAccount: { phone: oldPhone, passwordSalt: salt.toString('hex'), passwordHash: oldHash.toString('hex') },
      shop: { id: 'window-shop', name: '旧版门店' }, categories: [], items: [], orders: [], printJobs: [],
    }));
    server = await startServer(dataDir);
    const { request } = server;
    const origin = 'https://canxu-fixture.trycloudflare.com';
    publishDemoTunnel(dataDir, { origin, port: Number(new URL(server.url).port), pid: process.pid, status: 'ready' });
    const forwarded = { Host: new URL(origin).host, 'CF-Connecting-IP': '192.0.2.12', 'X-Forwarded-Proto': 'https' };
    const registrationPath = '/merchant?mode=register';
    const root = await request('/');
    assert.equal(root.status, 302);
    assert.equal(root.location, registrationPath);
    assert.match((await request(registrationPath)).data.toString(), /id="login-form"/);
    const share = await request('/api/demo/qr');
    assert.equal(share.data.url, origin + registrationPath);
    assert.match(share.data.image, /^data:image\/png;base64,/);
    assert.equal((await request('/api/store')).data.shop, null);
    assert.equal((await request('/api/admin/store')).status, 401);
    const oldSession = await request('/api/admin/login', { method: 'POST', body: { phone: oldPhone, password: oldPassword } });
    assert.equal((await request('/api/admin/store', { cookie: oldSession.cookie })).data.shop.id, 'window-shop');

    async function register(phone, password, name) {
      const session = await request('/api/admin/register', { method: 'POST', body: { phone, password }, headers: forwarded });
      assert.equal(session.status, 201);
      assert.match(session.setCookie, /; Secure$/);
      const { cookie } = session;
      const store = await request('/api/admin/store', { cookie });
      assert.deepEqual({ ...store.data.shop, id: '' }, { id: '', name: '', address: '', announcement: '' });
      assert.deepEqual(store.data.items, []);
      const item = await request('/api/admin/items', { cookie, method: 'POST', body: { name: '无分类餐品', priceCents: 500 } });
      assert.equal(item.status, 201);
      assert.equal(item.data.items[0].categoryId, null);
      const customerMenu = await request(`/api/store?store=${store.data.shop.id}`);
      assert.equal(customerMenu.data.items[0].name, '无分类餐品');
      assert.equal((await request(`/api/admin/items/${item.data.items[0].id}`, { cookie, method: 'DELETE' })).status, 200);
      await request('/api/admin/shop', { cookie, method: 'PUT', body: { name } });
      const category = await request('/api/admin/categories', { cookie, method: 'POST', body: { name: '主食' } });
      assert.equal(category.status, 201);
      return { cookie, name, id: store.data.shop.id, categoryId: category.data.categories[0].id, password, phone };
    }

    const a = await register('19900001112', 'test-store-A-pass', '门店甲');
    const b = await register('19900001113', 'test-store-B-pass', '门店乙');
    assert.notEqual(a.id, b.id);
    assert.equal((await request('/api/admin/register', { method: 'POST', body: { phone: a.phone, password: a.password } })).status, 409);
    const image = await QRCode.toDataURL('test-image');
    const upload = await request('/api/admin/upload', { cookie: a.cookie, method: 'POST', body: { dataUrl: image } });
    assert.equal(upload.status, 201);
    assert.deepEqual((await request(upload.data.imageUrl)).data, Buffer.from(image.split(',')[1], 'base64'));

    const meal = { name: '小面', priceCents: 1200, imageUrl: upload.data.imageUrl };
    assert.equal((await request('/api/admin/items', { cookie: b.cookie, method: 'POST', body: { ...meal, categoryId: b.categoryId } })).status, 400);
    for (const shop of [a, b]) {
      const payload = { ...meal, categoryId: shop.categoryId, imageUrl: shop === a ? meal.imageUrl : '', name: shop.name + '小面' };
      const item = await request('/api/admin/items', { cookie: shop.cookie, method: 'POST', body: payload });
      assert.equal(item.status, 201);
      shop.itemId = item.data.items[0].id;
      const links = await request('/api/admin/links', { cookie: shop.cookie, headers: forwarded });
      shop.link = links.data.url;
      assert.deepEqual(links.data.urls, [shop.link]);
      assert.equal(new URL(shop.link).origin, origin);
      assert.equal(new URL(shop.link).searchParams.get('store'), shop.id);
      const qr = await request('/api/admin/qr?url=' + encodeURIComponent(shop.link), { cookie: shop.cookie });
      assert.equal(qr.status, 200);
      assert.equal(qr.data.toString('ascii', 1, 4), 'PNG');
      assert.equal((await request(`/api/store?store=${shop.id}`)).data.items[0].name, payload.name);
      const orderBody = { items: [{ itemId: shop.itemId, quantity: 1 }] };
      const order = await request(`/api/orders?store=${shop.id}`, { method: 'POST', body: orderBody });
      assert.equal(order.status, 201);
      shop.order = order.data.order.id;
      const payPath = `/api/orders/${shop.order}/pay?store=${shop.id}`;
      const paid = await request(payPath, { method: 'POST', body: {} });
      assert.equal(paid.data.order.pickupNumber, '001');
      assert.equal((await request(payPath, { method: 'POST', body: {} })).data.order.pickupNumber, '001');
      assert.equal((await request('/api/admin/print-jobs', { cookie: shop.cookie })).data.jobs.length, 1);
    }

    const editPath = '/api/admin/items/' + a.itemId;
    const noCategory = await request(editPath, { cookie: a.cookie, method: 'PUT', body: { ...meal, categoryId: '' } });
    assert.equal(noCategory.status, 200);
    assert.equal(noCategory.data.items[0].categoryId, null);
    assert.equal((await request(editPath, { cookie: a.cookie, method: 'PUT', body: { ...meal, categoryId: b.categoryId } })).status, 400);
    assert.equal((await request(editPath, { cookie: b.cookie, method: 'DELETE' })).status, 404);
    assert.equal((await request('/api/admin/categories/' + a.categoryId, { cookie: b.cookie, method: 'DELETE' })).status, 404);
    assert.equal((await request('/api/admin/qr?url=' + encodeURIComponent(a.link), { cookie: b.cookie })).status, 400);
    assert.equal((await request(`/api/orders/${a.order}?store=${b.id}`)).status, 404);
    assert.equal((await request(`/api/orders/${a.order}/pay?store=${b.id}`, { method: 'POST', body: {} })).status, 404);
    assert.equal((await request(`/api/admin/orders/${a.order}`, { cookie: b.cookie, method: 'PATCH', body: { status: 'ready' } })).status, 404);
    assert.equal((await request(`/api/admin/orders/${a.order}/reprint`, { cookie: b.cookie, method: 'POST' })).status, 404);
    assert.deepEqual((await request('/api/admin/orders', { cookie: b.cookie })).data.orders.map(order => order.id), [b.order]);

    assert.equal((await request('/api/admin/password', { cookie: a.cookie, method: 'PUT', body: { currentPassword: a.password, newPassword: 'test-store-A-new-pass' } })).status, 200);
    assert.equal((await request('/api/admin/store', { cookie: a.cookie })).status, 401);
    assert.equal((await request('/api/admin/store', { cookie: b.cookie })).status, 200);
    await server.stop();
    server = await startServer(dataDir);
    assert.equal((await server.request('/api/admin/store', { cookie: b.cookie })).data.shop.id, b.id);
    const savedItem = (await server.request(`/api/store?store=${a.id}`)).data.items[0];
    assert.equal(savedItem.id, a.itemId);
    assert.equal(savedItem.categoryId, null);

    const database = new DatabaseSync(join(dataDir, 'ordering.sqlite'), { readOnly: true });
    try {
      assert.equal(database.prepare('SELECT count(*) AS count FROM shops').get().count, 3);
      assert.equal(database.prepare('SELECT count(*) AS count FROM orders').get().count, 2);
      assert.equal(database.prepare('SELECT count(*) AS count FROM accounts WHERE length(password_hash) = 128').get().count, 3);
      assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { database.close(); }
  } finally {
    if (server) await server.stop();
    const resolved = realpathSync(dataDir);
    if (/^multishop-test-[a-zA-Z0-9]+$/.test(relative(realpathSync(runtime), resolved))) {
      rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});
