import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import QRCode from 'qrcode';
import { paymentAdapter, printAdapter, resolveStoreEntry } from './lib/integrations.mjs';

const projectDir = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.env.DATA_DIR || resolve(projectDir, 'runtime', 'data'));
const publicDir = resolve(projectDir, 'public');
const uploadDir = resolve(dataDir, 'uploads');
const stateFile = resolve(dataDir, 'store.json');
const port = Number(process.env.PORT || 8787);
const bindHost = process.env.HOST || '0.0.0.0';
const publicBase = process.env.PUBLIC_BASE_URL?.trim();
const secureCookies = publicBase?.startsWith('https:') || process.env.SECURE_COOKIES === '1';
const maxUploadBytes = 2_500_000;
const sessionAge = 12 * 60 * 60 * 1000;
const sessions = new Map();
const requestWindows = new Map();
const deriveKey = promisify(scrypt);
const passwordHashOptions = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
let activePasswordChecks = 0;

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('PORT 无效');
if (publicBase) {
  const url = validatedWebUrl(publicBase);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_BASE_URL 须为网站根地址');
}
mkdirSync(uploadDir, { recursive: true });

let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {
  shop: { id: 'window-shop', name: '窗口小食', announcement: '', address: '' },
  categories: [],
  items: [],
  orders: [],
  printJobs: [],
};

const chinaDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const fileTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'], ['.woff', 'font/woff'], ['.ttf', 'font/ttf'],
]);

function requireValue(condition, status, code, message) {
  if (!condition) throw new RequestError(status, code, message);
}

function normalizedPhone(value) {
  if (typeof value !== 'string') return null;
  const phone = value.trim().replace(/^\+86\s*/, '');
  return /^1[3-9]\d{9}$/.test(phone) ? phone : null;
}

function validNewPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 256 && value.trim().length > 0;
}

async function hashPassword(password, salt) {
  requireValue(activePasswordChecks < 2, 429, 'TOO_MANY_REQUESTS', '操作频繁，请稍后重试');
  activePasswordChecks += 1;
  try {
    return await deriveKey(password, salt, 64, passwordHashOptions);
  } finally {
    activePasswordChecks -= 1;
  }
}

async function passwordMatches(account, password) {
  const hash = await hashPassword(password, Buffer.from(account.passwordSalt, 'hex'));
  return timingSafeEqual(hash, Buffer.from(account.passwordHash, 'hex'));
}

function textField(value, label, maxLength, required = false) {
  requireValue(typeof value === 'string', 400, 'INVALID_FIELD', `${label}格式有误`);
  const valueTrimmed = value.trim();
  requireValue(!required || valueTrimmed, 400, 'REQUIRED_FIELD', `请填写${label}`);
  requireValue([...valueTrimmed].length <= maxLength, 400, 'FIELD_TOO_LONG', `${label}最多 ${maxLength} 个字`);
  return valueTrimmed;
}

function validatedWebUrl(raw) {
  requireValue(typeof raw === 'string' && raw.length <= 2048, 400, 'INVALID_URL', '链接无效');
  let url;
  try { url = new URL(raw); } catch { throw new RequestError(400, 'INVALID_URL', '请填写完整的网址'); }
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password,
    400, 'INVALID_URL', '请输入 HTTP 或 HTTPS 链接');
  return url;
}

function transact(apply) {
  const draft = structuredClone(state);
  const answer = apply(draft);
  const temp = `${stateFile}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(draft, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temp, stateFile);
    state = draft;
  } finally {
    rmSync(temp, { force: true });
  }
  return answer;
}

function writeResponse(response, status, contentType, body) {
  response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  response.end(body);
}

function writeJson(response, status, payload) {
  writeResponse(response, status, 'application/json; charset=utf-8', JSON.stringify(payload));
}

async function readJson(request, limit = 32_768) {
  const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  requireValue(contentType === 'application/json', 415, 'JSON_REQUIRED', '请提交 JSON 数据');
  const announced = Number(request.headers['content-length'] ?? 0);
  requireValue(announced <= limit, 413, 'REQUEST_TOO_LARGE', '提交内容过大');
  const chunks = [];
  let count = 0;
  // Continue reading a chunked request without retaining excess bytes.
  for await (const chunk of request) {
    count += chunk.length;
    if (count <= limit) chunks.push(chunk);
  }
  requireValue(count <= limit, 413, 'REQUEST_TOO_LARGE', '提交内容过大');
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'INVALID_JSON', '提交格式有误'); }
  requireValue(body && typeof body === 'object' && !Array.isArray(body), 400, 'INVALID_JSON', '提交格式有误');
  return body;
}

function rateLimit(request, bucket, max, windowMs) {
  const key = `${bucket}:${request.socket.remoteAddress || 'unknown'}`;
  const now = Date.now();
  let window = requestWindows.get(key);
  if (!window || window.expiresAt <= now) {
    window = { count: 0, expiresAt: now + windowMs };
    requestWindows.set(key, window);
  }
  window.count += 1;
  requireValue(window.count <= max, 429, 'TOO_MANY_REQUESTS', '操作频繁，请稍后重试');
}

function getSessionToken(request) {
  const token = request.headers.cookie?.match(/(?:^|;\s*)merchant_session=([a-zA-Z0-9_-]+)(?:;|$)/)?.[1];
  if (token && (sessions.get(token) ?? 0) > Date.now()) return token;
  return null;
}

function sessionCookie(token, maxAge) {
  return `merchant_session=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
}

function isLocalRegistration(request) {
  const localAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
  return localAddresses.includes(request.socket.remoteAddress) && localHost.test(request.headers.host) &&
    !request.headers.forwarded && !request.headers['x-forwarded-for'] && !request.headers['x-real-ip'];
}

function startMerchantSession(response, oldToken, status) {
  const token = randomBytes(32).toString('base64url');
  if (oldToken) sessions.delete(oldToken);
  sessions.set(token, Date.now() + sessionAge);
  response.setHeader('Set-Cookie', sessionCookie(token, Math.floor(sessionAge / 1000)));
  return writeJson(response, status, { authenticated: true, registered: true });
}

function waitingCount() {
  return state.orders.filter(order => order.paymentStatus === 'paid' && order.status === 'preparing').length;
}

function storeView(includeInactive = false) {
  return {
    shop: state.shop,
    categories: state.categories,
    items: includeInactive ? state.items : state.items.filter(item => item.active),
    waitingCount: waitingCount(),
  };
}

function orderById(data, id) {
  const order = data.orders.find(record => record.id === id);
  requireValue(order, 404, 'ORDER_NOT_FOUND', '未找到该订单');
  return order;
}

function createOrder(body) {
  requireValue(Array.isArray(body.items) && body.items.length >= 1 && body.items.length <= 40,
    400, 'EMPTY_CART', '请选择至少一份餐品');
  const note = textField(body.note ?? '', '备注', 200);
  const quantities = new Map();
  for (const line of body.items) {
    requireValue(line && typeof line.itemId === 'string' && Number.isInteger(line.quantity) && line.quantity >= 1 && line.quantity <= 99,
      400, 'INVALID_QUANTITY', '每种餐品数量须为 1 至 99');
    const quantity = (quantities.get(line.itemId) ?? 0) + line.quantity;
    requireValue(quantity <= 99, 400, 'INVALID_QUANTITY', '每种餐品最多可点 99 份');
    quantities.set(line.itemId, quantity);
  }
  return transact(draft => {
    const items = [];
    for (const [id, quantity] of quantities) {
      const item = draft.items.find(record => record.id === id && record.active);
      requireValue(item, 409, 'ITEM_UNAVAILABLE', '有餐品已下架，请刷新菜单后重试');
      items.push({ itemId: item.id, name: item.name, quantity, unitPriceCents: item.priceCents });
    }
    const totalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
    requireValue(totalCents > 0 && totalCents <= 9_999_999, 400, 'INVALID_TOTAL', '订单金额超出范围，请调整数量');
    const order = {
      id: randomUUID(), shopId: draft.shop.id, shopName: draft.shop.name,
      status: 'pending', pickupNumber: null, items, totalCents, note,
      createdAt: new Date().toISOString(), paidAt: null,
      paymentStatus: 'unpaid', printStatus: 'not_requested',
    };
    draft.orders.push(order);
    return order;
  });
}

function addPrintJob(draft, order, reason) {
  const job = printAdapter.createJob(order, reason);
  draft.printJobs.push(job);
  order.printStatus = job.status;
  order.printedAt = job.createdAt;
}

function recordConfirmedPayment(draft, payment) {
  const order = orderById(draft, payment.orderId);
  requireValue(payment.amountCents === order.totalCents && payment.transactionId,
    409, 'PAYMENT_MISMATCH', '支付信息和订单不一致');
  if (order.paymentStatus === 'paid') return order;
  requireValue(!draft.orders.some(other => other.paymentTransactionId === payment.transactionId),
    409, 'PAYMENT_DUPLICATE', '该笔支付已用于其他订单');
  const day = chinaDay.format(new Date(payment.paidAt));
  const usedNumbers = new Set();
  for (const paidOrder of draft.orders) {
    if (paidOrder.pickupNumber && paidOrder.paidAt && chinaDay.format(new Date(paidOrder.paidAt)) === day) {
      usedNumbers.add(Number(paidOrder.pickupNumber));
    }
  }
  let nextNumber = 1;
  while (usedNumbers.has(nextNumber)) nextNumber += 1;
  order.pickupNumber = String(nextNumber).padStart(3, '0');
  order.status = 'preparing';
  order.paymentStatus = 'paid';
  order.paymentTransactionId = payment.transactionId;
  order.paidAt = payment.paidAt;
  addPrintJob(draft, order, 'paid');
  return order;
}

function simulatePayment(id) {
  const existing = orderById(state, id);
  if (existing.paymentStatus === 'paid') return existing;
  requireValue(paymentAdapter.mode === 'simulation', 409, 'SIMULATION_DISABLED', '当前门店未启用模拟支付');
  return transact(draft => {
    const payment = paymentAdapter.create(orderById(draft, id));
    return recordConfirmedPayment(draft, paymentAdapter.confirmSimulation(payment));
  });
}

function validateItem(body, draft) {
  const name = textField(body.name, '餐品名称', 40, true);
  const description = textField(body.description ?? '', '餐品介绍', 160);
  const priceCents = body.priceCents;
  requireValue(Number.isInteger(priceCents) && priceCents > 0 && priceCents <= 999_999,
    400, 'INVALID_PRICE', '餐品价格须在 ¥0.01 至 ¥9999.99 之间');
  const category = draft.categories.find(record => record.id === body.categoryId);
  requireValue(category, 400, 'CATEGORY_REQUIRED', '请选择一个有效分类');
  const imageUrl = textField(body.imageUrl ?? '', '图片地址', 2048);
  if (imageUrl && !/^\/uploads\/[\w-]+\.(png|jpg|webp)$/.test(imageUrl) && !/^\/assets\/[\w./-]+$/.test(imageUrl)) validatedWebUrl(imageUrl);
  requireValue(body.active === undefined || typeof body.active === 'boolean', 400, 'INVALID_ACTIVE', '上架状态无效');
  return { name, description, priceCents, categoryId: category.id, imageUrl, active: body.active ?? true };
}

function imageType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width > 0 && width <= 8192 && height > 0 && height <= 8192) return { mime: 'image/png', extension: '.png' };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return { mime: 'image/jpeg', extension: '.jpg' };
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return { mime: 'image/webp', extension: '.webp' };
  return null;
}

function storeUpload(dataUrl) {
  requireValue(typeof dataUrl === 'string', 400, 'INVALID_IMAGE', '请选择有效图片');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  requireValue(match && match[2].length % 4 === 0, 400, 'INVALID_IMAGE', '请选择 JPG、PNG 或 WebP 图片');
  const bytes = Buffer.from(match[2], 'base64');
  requireValue(bytes.length > 0 && bytes.length <= maxUploadBytes, 413, 'IMAGE_TOO_LARGE', '图片不能大于 2.5 MB');
  const type = imageType(bytes);
  requireValue(type?.mime === match[1], 400, 'INVALID_IMAGE', '图片内容和所选格式不一致');
  const filename = randomUUID() + type.extension;
  writeFileSync(resolve(uploadDir, filename), bytes, { mode: 0o600, flag: 'wx' });
  return `/uploads/${filename}`;
}

function shopLinks(actualPort) {
  const suffix = `/?store=${encodeURIComponent(state.shop.id)}`;
  const interfaces = Object.entries(networkInterfaces())
    .sort(([first], [second]) => Number(/Wi-Fi|WLAN|以太网|Ethernet/i.test(second)) - Number(/Wi-Fi|WLAN|以太网|Ethernet/i.test(first)));
  const ips = interfaces.flatMap(([, records]) => (records ?? []).filter(record =>
    record.family === 'IPv4' && !record.internal && !record.address.startsWith('169.254.')).map(record => record.address));
  const loopback = `http://localhost:${actualPort}${suffix}`;
  const urls = [];
  if (publicBase) {
    const configured = validatedWebUrl(publicBase);
    urls.push(new URL(suffix, configured).href);
  }
  if (bindHost === '0.0.0.0' || bindHost === '::') urls.push(...ips.map(ip => `http://${ip}:${actualPort}${suffix}`));
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bindHost) && !bindHost.startsWith('127.') && bindHost !== '0.0.0.0') urls.push(`http://${bindHost}:${actualPort}${suffix}`);
  const unique = [...new Set(urls)];
  return { url: unique[0] ?? loopback, urls: unique.length ? unique : [loopback] };
}

async function adminRoute(request, response, url) {
  const { pathname } = url;
  const method = request.method;
  const token = getSessionToken(request);
  if (method === 'GET' && pathname === '/api/admin/session') return writeJson(response, 200, {
    authenticated: Boolean(token),
    registered: Boolean(state.merchantAccount),
    registrationAllowed: !state.merchantAccount && isLocalRegistration(request),
  });
  if (method === 'POST' && pathname === '/api/admin/register') {
    requireValue(isLocalRegistration(request), 403, 'LOCAL_REGISTRATION_REQUIRED', '请在运行系统的电脑上注册');
    requireValue(!state.merchantAccount, 409, 'ALREADY_REGISTERED', '商家账号已注册，请登录');
    rateLimit(request, 'merchant_register', 5, 60_000);
    const body = await readJson(request, 2048);
    const phone = normalizedPhone(body.phone);
    requireValue(phone, 400, 'INVALID_PHONE', '请输入有效的 11 位手机号');
    requireValue(validNewPassword(body.password),
      400, 'INVALID_PASSWORD', '密码须为 8 至 256 个字符');
    const salt = randomBytes(16);
    const passwordHash = await hashPassword(body.password, salt);
    transact(draft => {
      requireValue(!draft.merchantAccount, 409, 'ALREADY_REGISTERED', '商家账号已注册，请登录');
      draft.merchantAccount = { phone, passwordSalt: salt.toString('hex'), passwordHash: passwordHash.toString('hex') };
    });
    return startMerchantSession(response, token, 201);
  }
  if (method === 'POST' && pathname === '/api/admin/login') {
    rateLimit(request, 'merchant_login', 10, 60_000);
    const account = state.merchantAccount;
    requireValue(account, 409, 'REGISTRATION_REQUIRED', '请先注册商家账号');
    const body = await readJson(request, 2048);
    const phone = normalizedPhone(body.phone);
    requireValue(phone && typeof body.password === 'string' && body.password.length >= 8 && body.password.length <= 256,
      401, 'INVALID_CREDENTIALS', '手机号或密码不正确');
    requireValue(await passwordMatches(account, body.password) && phone === account.phone &&
      state.merchantAccount?.passwordHash === account.passwordHash,
      401, 'INVALID_CREDENTIALS', '手机号或密码不正确');
    return startMerchantSession(response, token, 200);
  }
  if (method === 'POST' && pathname === '/api/admin/logout') {
    if (token) sessions.delete(token);
    response.setHeader('Set-Cookie', sessionCookie('', 0));
    return writeJson(response, 200, { authenticated: false });
  }
  requireValue(token, 401, 'AUTH_REQUIRED', '请先登录商家后台');
  if (method === 'PUT' && pathname === '/api/admin/password') {
    rateLimit(request, 'merchant_password', 5, 60_000);
    const { currentPassword, newPassword } = await readJson(request, 4096);
    requireValue(typeof currentPassword === 'string' && currentPassword.length >= 8 && currentPassword.length <= 256,
      400, 'INVALID_CURRENT_PASSWORD', '当前密码不正确');
    requireValue(validNewPassword(newPassword), 400, 'INVALID_PASSWORD', '新密码须为 8 至 256 个字符');
    const account = state.merchantAccount;
    requireValue(account && await passwordMatches(account, currentPassword),
      400, 'INVALID_CURRENT_PASSWORD', '当前密码不正确');
    requireValue(newPassword !== currentPassword, 400, 'PASSWORD_UNCHANGED', '新密码须与当前密码不同');

    const salt = randomBytes(16);
    const hash = await hashPassword(newPassword, salt);
    transact(draft => {
      requireValue(getSessionToken(request) === token, 401, 'AUTH_REQUIRED', '请重新登录商家后台');
      requireValue(draft.merchantAccount?.passwordHash === account.passwordHash,
        409, 'PASSWORD_CHANGED', '密码已更新，请重新登录');
      draft.merchantAccount.passwordSalt = salt.toString('hex');
      draft.merchantAccount.passwordHash = hash.toString('hex');
    });
    sessions.clear();
    response.setHeader('Set-Cookie', sessionCookie('', 0));
    return writeJson(response, 200, { authenticated: false, registered: true });
  }
  if (method === 'GET' && pathname === '/api/admin/store') return writeJson(response, 200, storeView(true));
  if (method === 'GET' && pathname === '/api/admin/links') return writeJson(response, 200, shopLinks(request.socket.localPort));
  if (method === 'GET' && pathname === '/api/admin/qr') {
    rateLimit(request, 'merchant_qr', 60, 60_000);
    const landing = validatedWebUrl(url.searchParams.get('url') ?? shopLinks(request.socket.localPort).url);
    const qr = await QRCode.toBuffer(landing.href, { width: 512, margin: 3, errorCorrectionLevel: 'M' });
    return writeResponse(response, 200, 'image/png', qr);
  }
  if (method === 'POST' && pathname === '/api/admin/upload') {
    rateLimit(request, 'merchant_upload', 40, 60_000);
    const body = await readJson(request, 3_350_000);
    return writeJson(response, 201, { imageUrl: storeUpload(body.dataUrl) });
  }
  if (method === 'PUT' && pathname === '/api/admin/shop') {
    const body = await readJson(request);
    transact(draft => Object.assign(draft.shop, {
      name: textField(body.name, '店铺名称', 32, true),
      announcement: textField(body.announcement ?? '', '门店公告', 120),
      address: textField(body.address ?? '', '门店地址', 120),
    }));
    return writeJson(response, 200, storeView(true));
  }
  if (method === 'GET' && pathname === '/api/admin/orders') {
    const orders = state.orders.filter(order => order.paymentStatus === 'paid').slice().reverse();
    return writeJson(response, 200, { orders });
  }
  if (method === 'GET' && pathname === '/api/admin/print-jobs') {
    const orderId = url.searchParams.get('orderId');
    const jobs = orderId ? state.printJobs.filter(job => job.orderId === orderId) : state.printJobs;
    return writeJson(response, 200, { jobs: jobs.slice().reverse() });
  }

  const orderMatch = /^\/api\/admin\/orders\/([a-f0-9-]{36})(\/reprint)?$/.exec(pathname);
  if (orderMatch && method === 'PATCH' && !orderMatch[2]) {
    const body = await readJson(request);
    const order = transact(draft => {
      const record = orderById(draft, orderMatch[1]);
      const allowedMove = record.paymentStatus === 'paid' && ((body.status === 'ready' && record.status === 'preparing') ||
        (body.status === 'picked' && record.status === 'ready') || (['ready', 'picked'].includes(body.status) && record.status === body.status));
      requireValue(allowedMove, 409, 'INVALID_ORDER_STATUS', '请按制作中、待取餐、已取餐的顺序更新订单');
      if (record.status !== body.status) {
        record.status = body.status;
        record[body.status === 'ready' ? 'readyAt' : 'pickedAt'] = new Date().toISOString();
      }
      return record;
    });
    return writeJson(response, 200, { order });
  }
  if (orderMatch && method === 'POST' && orderMatch[2]) {
    const order = transact(draft => {
      const record = orderById(draft, orderMatch[1]);
      requireValue(record.paymentStatus === 'paid', 409, 'ORDER_UNPAID', '付款成功后可补打标签');
      addPrintJob(draft, record, 'reprint');
      return record;
    });
    return writeJson(response, 200, { order });
  }

  const menuMatch = /^\/api\/admin\/(categories|items)(?:\/([a-f0-9-]{36}))?$/.exec(pathname);
  if (menuMatch) {
    const [, collection, id] = menuMatch;
    if (method === 'DELETE' && id) {
      transact(draft => {
        const index = draft[collection].findIndex(record => record.id === id);
        requireValue(index >= 0, 404, 'MENU_RECORD_NOT_FOUND', '找不到这条菜单记录');
        if (collection === 'categories') {
          requireValue(!draft.items.some(item => item.categoryId === id), 409, 'CATEGORY_NOT_EMPTY', '请先移走或删除这个分类中的餐品');
        }
        draft[collection].splice(index, 1);
      });
      return writeJson(response, 200, storeView(true));
    }
    if ((method === 'POST' && !id) || (method === 'PUT' && id)) {
      const body = await readJson(request);
      transact(draft => {
        const records = draft[collection];
        const index = id ? records.findIndex(record => record.id === id) : -1;
        if (id) requireValue(index >= 0, 404, 'MENU_RECORD_NOT_FOUND', '找不到这条菜单记录');
        if (!id) requireValue(records.length < (collection === 'categories' ? 50 : 500), 400, 'MENU_LIMIT', '菜单已达到可添加的数量上限');
        const data = collection === 'categories' ? { name: textField(body.name, '分类名称', 24, true) } : validateItem(body, draft);
        if (collection === 'categories') {
          requireValue(!records.some(record => record.id !== id && record.name.toLocaleLowerCase() === data.name.toLocaleLowerCase()),
            409, 'DUPLICATE_CATEGORY', '这个分类名称已存在');
        }
        const record = { id: id ?? randomUUID(), ...data };
        if (id) records[index] = record;
        else records.push(record);
      });
      return writeJson(response, method === 'POST' ? 201 : 200, storeView(true));
    }
  }
  throw new RequestError(404, 'NOT_FOUND', '未找到此接口');
}

async function apiRoute(request, response, url) {
  const method = request.method;
  const { pathname } = url;
  if (!['GET', 'HEAD'].includes(method)) {
    requireValue(request.headers['sec-fetch-site'] !== 'cross-site', 403, 'CROSS_SITE_REQUEST', '请在本网页内操作');
  }
  if (pathname.startsWith('/api/admin/')) return adminRoute(request, response, url);
  if (method === 'GET' && pathname === '/api/store') {
    requireValue(resolveStoreEntry(url, state.shop), 404, 'STORE_NOT_FOUND', '未找到此门店，请重新扫描店铺二维码');
    return writeJson(response, 200, storeView());
  }
  if (method === 'GET' && pathname === '/api/queue') {
    requireValue(resolveStoreEntry(url, state.shop), 404, 'STORE_NOT_FOUND', '未找到此门店，请重新扫描店铺二维码');
    return writeJson(response, 200, { waitingCount: waitingCount() });
  }
  if (method === 'GET' && pathname === '/api/health') return writeJson(response, 200, { ok: true, paymentMode: paymentAdapter.mode, printMode: printAdapter.mode });
  if (method === 'POST' && pathname === '/api/orders') {
    rateLimit(request, 'order_create', 50, 60_000);
    const body = await readJson(request);
    return writeJson(response, 201, { order: createOrder(body) });
  }
  const orderMatch = /^\/api\/orders\/([a-f0-9-]{36})(\/pay)?$/.exec(pathname);
  if (orderMatch && method === 'GET' && !orderMatch[2]) return writeJson(response, 200, { order: orderById(state, orderMatch[1]) });
  if (orderMatch && method === 'POST' && orderMatch[2]) {
    rateLimit(request, 'order_payment', 80, 60_000);
    await readJson(request, 2048);
    return writeJson(response, 200, { order: simulatePayment(orderMatch[1]) });
  }
  throw new RequestError(404, 'NOT_FOUND', '未找到此接口');
}

function serveFile(request, response, url) {
  requireValue(['GET', 'HEAD'].includes(request.method), 405, 'METHOD_NOT_ALLOWED', '此页面仅支持读取');
  let path;
  try { path = decodeURIComponent(url.pathname); }
  catch { throw new RequestError(400, 'INVALID_PATH', '链接有误'); }
  if (path === '/') path = '/index.html';
  if (path === '/merchant' || path === '/merchant/') path = '/merchant.html';
  if (path === '/order' || path === '/order/') path = '/index.html';
  const upload = path.startsWith('/uploads/');
  const directory = upload ? uploadDir : publicDir;
  const relativePath = upload ? path.slice('/uploads/'.length) : path.slice(1);
  requireValue(!relativePath.includes('\\') && !relativePath.includes('\0') && !relativePath.split('/').some(part => part.startsWith('.')),
    404, 'NOT_FOUND', '该页面不存在');
  const file = resolve(directory, relativePath);
  const extension = extname(file).toLowerCase();
  const contentType = fileTypes.get(extension);
  const detail = file.startsWith(`${directory}${sep}`) && contentType ? statSync(file, { throwIfNoEntry: false }) : undefined;
  requireValue(detail?.isFile(), 404, 'NOT_FOUND', '该页面不存在');
  response.writeHead(200, {
    'Content-Type': contentType, 'Content-Length': detail.size,
    'Cache-Control': extension === '.html' ? 'no-cache' : (upload ? 'public, max-age=31536000, immutable' : 'no-cache'),
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).on('error', () => response.destroy()).pipe(response);
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  try {
    const url = new URL(request.url, 'http://demo.local');
    if (url.pathname.startsWith('/api/')) await apiRoute(request, response, url);
    else serveFile(request, response, url);
  } catch (error) {
    if (response.headersSent) return response.destroy();
    if (error instanceof RequestError) return writeJson(response, error.status, { error: { code: error.code, message: error.message } });
    console.error(error);
    return writeJson(response, 500, { error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' } });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) if (expiry <= now) sessions.delete(token);
  for (const [key, window] of requestWindows) if (window.expiresAt <= now) requestWindows.delete(key);
}, 60_000).unref();

server.listen(port, bindHost, () => {
  const actualPort = server.address().port;
  console.log(`本机点餐地址  http://localhost:${actualPort}`);
  console.log(`本机商家后台  http://localhost:${actualPort}/merchant`);
  for (const url of shopLinks(actualPort).urls) console.log(`扫码点餐地址  ${url}`);
  console.log(state.merchantAccount ? '商家后台已开通，请使用手机号登录' : '首次使用请在本机注册商家账号');
  if (process.platform === 'win32' && process.env.ORDER_DEMO_OPEN_BROWSER === '1') {
    const browser = spawn('cmd.exe', ['/d', '/s', '/c', `start "" "http://127.0.0.1:${actualPort}/"`], {
      windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore',
    });
    browser.on('error', () => console.log('请在浏览器中打开本机点餐地址'));
    browser.unref();
  }
});
