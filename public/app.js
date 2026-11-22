const $ = (selector) => document.querySelector(selector);
const icons = {
  store: '<path d="M4 10v10h16V10M3 10l2-6h14l2 6M3 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M9 20v-6h6v6"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12a2 2 0 0 0 4 0"/>',
  bag: '<path d="M4 8h16l1 13H3L4 8Zm4 2V7a4 4 0 0 1 8 0v3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  bowl: '<path d="M3 13h18a9 9 0 0 1-18 0Zm5 9h8M8 3C6 5 10 7 8 9m4-7c-2 2 2 4 0 6m4-5c-2 2 2 4 0 6"/>',
  ticket: '<path d="M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4V6Zm10 3h4m-4 6h4M9 8v8"/>'
};
const icon = (name) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>';
document.querySelectorAll('[data-icon]').forEach((node) => { node.innerHTML = icon(node.dataset.icon); });

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
const cart = new Map(Object.entries(read('canxu:cart', {})));
let history = read('canxu:orders', []);
let pending = read('canxu:pending', null);
let store = { shop: { name: '窗口小食' }, categories: [], items: [] };
let selectedCategory = '';
let view = 'menu';
let hasMenu = false;
let paying = false;
let currentReceipt = '';
let toastTimer;
const storeId = new URLSearchParams(location.search).get('store');
const storeQuery = storeId === null ? '' : '?store=' + encodeURIComponent(storeId);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const html = (value) => String(value ?? '').replace(/[&<>"']/g, (mark) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[mark]));
const money = (cents) => '¥' + (Number(cents || 0) / 100).toFixed(2);
const timeLabel = (iso) => new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai'
}).format(new Date(iso));
const states = { pending: '待支付', preparing: '制作中', ready: '待取餐', picked: '已取餐' };

async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  });
  if (response.status === 204) return {};
  let data;
  try { data = await response.json(); } catch { throw new Error('服务暂时不可用，请稍后再试。'); }
  if (!response.ok) {
    const error = new Error(data.error?.message || '操作未完成，请稍后再试。');
    error.status = response.status;
    throw error;
  }
  return data;
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2700);
}

function empty(title, message, symbol = 'bowl') {
  return '<div class="empty"><span class="empty-icon">' + icon(symbol) + '</span><strong>' + html(title) + '</strong><p>' + html(message) + '</p></div>';
}

async function loadStore({ quiet = false } = {}) {
  try {
    const data = await api('/api/store' + storeQuery);
    store = data;
    hasMenu = true;
    if (!store.categories.some((category) => category.id === selectedCategory)) selectedCategory = '';
    $('#store-name').textContent = store.shop.name;
    $('#hero-store').textContent = store.shop.name;
    $('#store-address').textContent = store.shop.address || '请到门店窗口领取餐品';
    $('#store-announcement').textContent = store.shop.announcement || '';
    $('#store-notice').hidden = !store.shop.announcement;
    const ids = new Set(store.items.map((item) => item.id));
    for (const id of cart.keys()) {
      if (!ids.has(id)) cart.delete(id);
    }
    write('canxu:cart', Object.fromEntries(cart));
    renderCategories();
    renderMenu();
    renderCart();
  } catch (error) {
    if (!quiet || !hasMenu) {
      $('#menu-list').innerHTML = empty('菜单暂时无法加载', error.message) +
        '<button type="button" class="secondary" id="reload-menu">重新加载</button>';
    }
  }
}

function controls(item, quantity) {
  const label = html(item.name);
  const id = html(item.id);
  const decrease = quantity
    ? '<button class="minus" type="button" data-adjust="-1" data-item="' + id + '" aria-label="减少' + label + '">' + icon('minus') + '</button><span aria-label="数量">' + quantity + '</span>'
    : '';
  return '<div class="qty">' + decrease +
    '<button type="button" data-adjust="1" data-item="' + id + '" aria-label="添加' + label + '"' + (quantity >= 99 ? ' disabled' : '') + '>' + icon('plus') + '</button></div>';
}

function renderCategories() {
  const nav = $('#categories');
  const categories = [{ id: '', name: '全部' }, ...store.categories];
  const markup = categories.map((category) =>
    '<button type="button" data-category="' + html(category.id) + '" aria-pressed="' + (category.id === selectedCategory) + '">' + html(category.name) + '</button>'
  ).join('');
  if (nav.innerHTML === markup) return;
  const scroll = nav.scrollLeft;
  const focusedCategory = nav.contains(document.activeElement) ? document.activeElement.dataset.category : undefined;
  nav.innerHTML = markup;
  nav.scrollLeft = scroll;
  if (focusedCategory !== undefined) {
    nav.querySelector('[data-category="' + CSS.escape(focusedCategory) + '"]')?.focus({ preventScroll: true });
  }
}

function renderMenu({ stagger = false } = {}) {
  const query = $('#menu-search').value.trim().toLowerCase();
  const items = store.items.filter((item) => (!selectedCategory || item.categoryId === selectedCategory) &&
    (!query || (item.name + ' ' + item.description).toLowerCase().includes(query)));
  const panel = $('#menu-list');
  if (!items.length) {
    panel.innerHTML = store.items.length
      ? empty('没有找到餐品', '换个关键词，或试试其他分类。')
      : empty('菜单准备中', '门店上架餐品后，即可在这里点餐。');
    return;
  }
  panel.innerHTML = items.map((item, index) => {
    const photo = item.imageUrl ? '<img loading="lazy" src="' + html(item.imageUrl) + '" alt="' + html(item.name) + '">' : '';
    const cardClass = stagger && index < 3 ? 'dish dish-enter' : 'dish';
    return '<article class="' + cardClass + '"><div class="dish-photo">' + icon('bowl') + photo + '</div><div><h3>' + html(item.name) + '</h3>' +
      (item.description ? '<p>' + html(item.description) + '</p>' : '') +
      '<strong class="price">' + money(item.priceCents) + '</strong></div>' + controls(item, cart.get(item.id) || 0) + '</article>';
  }).join('');
  panel.querySelectorAll('.dish-photo img').forEach((image) => {
    image.addEventListener('error', () => { image.hidden = true; }, { once: true });
  });
}

function selections() {
  return store.items.filter((item) => cart.get(item.id) > 0).map((item) => ({ item, quantity: cart.get(item.id) }));
}
function cartSum(lines) {
  return lines.reduce((sum, line) => sum + line.item.priceCents * line.quantity, 0);
}
function renderCart() {
  const lines = selections();
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const total = money(cartSum(lines));
  const markup = lines.length ? lines.map(({ item, quantity }) =>
    '<div class="cart-line"><div><span class="line-name">' + html(item.name) + '</span><span class="line-price">' + money(item.priceCents * quantity) + '</span></div>' + controls(item, quantity) + '</div>'
  ).join('') : '<div class="cart-empty"><p>还没有选餐</p></div>';
  $('#cart-lines').innerHTML = markup;
  $('#sheet-cart-lines').innerHTML = markup;
  $('#cart-total').textContent = total;
  $('#sheet-cart-total').textContent = total;
  $('#mobile-count').textContent = count + ' 份餐品';
  $('#mobile-total').textContent = total;
  $('#mobile-cart').hidden = !count || view !== 'menu';
  $('#checkout-desktop').disabled = !count;
  $('#checkout-sheet').disabled = !count;
}

function animateCartAddition(origin, fromSheet) {
  let bag = $(fromSheet ? '#sheet-bag-icon' : '#desktop-bag-icon');
  if (!fromSheet && !bag.getClientRects().length) bag = $('#mobile-bag-icon');
  const destination = bag.getBoundingClientRect();
  if (!destination.width) return;

  const dx = origin.x + origin.width / 2 - destination.x - destination.width / 2;
  const dy = origin.y + origin.height / 2 - destination.y - destination.height / 2;
  const distance = Math.hypot(dx, dy);
  const arcHeight = Math.max(Math.abs(dy) / 4 + 16, Math.min(80, 24 + distance * .14));
  const frames = Array.from({ length: 9 }, (_, index) => {
    const t = index / 8;
    const x = dx * (1 - t);
    const y = dy * (1 - t) - arcHeight * 4 * t * (1 - t);
    const size = 1 - .55 * t ** 3;
    return { transform: `translate(${x}px, ${y}px) scale(${size})`, opacity: Math.min(1, (1 - t) * 5) };
  });

  const ball = document.createElement('span');
  ball.className = 'cart-flight';
  bag.append(ball);
  const flight = ball.animate(frames, {
    duration: Math.min(550, 320 + distance * .25),
    easing: 'cubic-bezier(.25, .55, .55, 1)',
  });
  flight.oncancel = () => ball.remove();
  flight.onfinish = () => {
    ball.remove();
    if (reducedMotion.matches) return;
    bag.querySelector('svg').animate([{ scale: 1 }, { scale: 1.16 }, { scale: 1 }], {
      duration: 190,
      easing: 'ease-out',
    });
  };
}

function dialog(name) { return document.getElementById(name); }
function renderCheckout(lines) {
  $('#checkout-store').textContent = store.shop.name;
  $('#checkout-lines').innerHTML = lines.map(({ item, quantity }) =>
    '<div class="cart-line"><span>' + html(item.name) + ' × ' + quantity + '</span><strong>' + money(item.priceCents * quantity) + '</strong></div>'
  ).join('');
  $('#checkout-total').textContent = money(cartSum(lines));
}
function openCheckout() {
  const lines = selections();
  if (!lines.length || paying) return;
  if (dialog('cart-dialog').open) dialog('cart-dialog').close();
  renderCheckout(lines);
  $('#pay-button').disabled = false;
  $('#pay-error').hidden = true;
  dialog('checkout-dialog').showModal();
}

function saveOrder(order) {
  history = [order, ...history.filter((old) => old.id !== order.id)].slice(0, 30);
  write('canxu:orders', history);
}

async function pay(event) {
  event.preventDefault();
  if (paying) return;
  const lines = selections();
  if (!lines.length) return;
  const items = lines.map(({ item, quantity }) => ({ itemId: item.id, quantity }));
  const note = $('#order-note').value.trim();
  const expectedCents = cartSum(lines);
  const signature = JSON.stringify({ items, note, expectedCents });
  paying = true;
  const button = $('#pay-button');
  button.disabled = true;
  button.textContent = '确认中…';
  $('#pay-error').hidden = true;
  try {
    if (!pending || pending.signature !== signature) {
      const { order } = await api('/api/orders', 'POST', { items, note });
      if (order.totalCents !== expectedCents) {
        await loadStore({ quiet: true });
        renderCheckout(selections());
        throw new Error('餐品价格已更新，请核对金额后重新确认。');
      }
      pending = { id: order.id, signature };
      write('canxu:pending', pending);
    }
    const { order } = await api('/api/orders/' + encodeURIComponent(pending.id) + '/pay', 'POST', {});
    saveOrder(order);
    pending = null;
    write('canxu:pending', null);
    cart.clear();
    write('canxu:cart', {});
    $('#order-note').value = '';
    renderMenu();
    renderCart();
    dialog('checkout-dialog').close();
    setView('orders');
    showReceipt(order);
  } catch (error) {
    $('#pay-error').textContent = error.message;
    $('#pay-error').hidden = false;
    if (error.status === 404) { pending = null; write('canxu:pending', null); }
    if (error.status === 409 || error.status === 422) {
      await loadStore({ quiet: true });
      renderCheckout(selections());
    }
  } finally {
    paying = false;
    button.disabled = !selections().length;
    button.textContent = '确认模拟支付';
  }
}

function renderHistory() {
  $('#order-history').innerHTML = history.length ? history.map((order) => {
    const summary = order.items.map((item) => item.name + ' × ' + item.quantity).join('、');
    return '<button class="order-card" type="button" data-order="' + html(order.id) + '"><span><span class="title">取餐号 ' + html(order.pickupNumber) + '</span><small>' + html(summary) +
      '</small><small>' + html(timeLabel(order.createdAt)) + '</small></span><span class="order-side"><span class="title">' + html(states[order.status]) + '</span><small>' + money(order.totalCents) + '</small></span></button>';
  }).join('') : '<div class="empty-orders">' + empty('暂无订单', '下单后可在这里查询取餐号和订单状态。', 'ticket') + '</div>';
}

function renderReceipt(order) {
  $('#receipt-content').innerHTML = '<div class="receipt-number"><span>取餐号</span><strong>' + html(order.pickupNumber) +
    '</strong><span>' + html(states[order.status]) + ' · 到店自取</span></div><div class="checkout-lines">' +
    order.items.map((item) => '<div class="cart-line"><span>' + html(item.name) + ' × ' + item.quantity + '</span><strong>' + money(item.unitPriceCents * item.quantity) + '</strong></div>').join('') +
    '</div><ul class="order-meta"><li><span>订单金额</span><strong>' + money(order.totalCents) +
    '</strong></li><li><span>支付状态</span><span>模拟支付成功</span></li><li><span>下单时间</span><span>' + html(timeLabel(order.createdAt)) +
    '</span></li>' +
    (order.note ? '<li><span>餐品备注</span><span>' + html(order.note) + '</span></li>' : '') + '</ul>';
}

function showReceipt(order) {
  currentReceipt = order.id;
  renderReceipt(order);
  if (!dialog('receipt-dialog').open) dialog('receipt-dialog').showModal();
}

async function refreshOrders() {
  if (view !== 'orders') return;
  const openOrders = history.filter((order) => order.status !== 'picked').slice(0, 15);
  await Promise.allSettled(openOrders.map(async ({ id }) => {
    const { order } = await api('/api/orders/' + encodeURIComponent(id));
    const index = history.findIndex((entry) => entry.id === id);
    if (index >= 0) history[index] = order;
    if (currentReceipt === id && dialog('receipt-dialog').open) renderReceipt(order);
  }));
  write('canxu:orders', history);
  if (view === 'orders') renderHistory();
}

function setView(next) {
  if (view !== next) {
    $(`#${next}-view`).classList.add('panel-enter');
    if (view === 'menu') document.querySelectorAll('.dish-enter').forEach(card => card.classList.remove('dish-enter'));
  }
  view = next;
  $('#menu-view').hidden = next !== 'menu';
  $('#orders-view').hidden = next !== 'orders';
  document.querySelectorAll('[data-view]').forEach((tab) => {
    tab.classList.toggle('selected', tab.dataset.view === next);
    if (tab.dataset.view === next) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  renderCart();
  if (next === 'orders') { renderHistory(); void refreshOrders(); }
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.view) setView(button.dataset.view);
  if (button.dataset.close && !(paying && button.dataset.close === 'checkout-dialog')) dialog(button.dataset.close).close();
  if (button.dataset.category !== undefined && button.dataset.category !== selectedCategory) {
    selectedCategory = button.dataset.category;
    $('#categories').querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-pressed', 'true');
    renderMenu({ stagger: true });
  }
  if (button.dataset.adjust) {
    const id = button.dataset.item;
    if (!store.items.some((item) => item.id === id)) return;
    const previousQuantity = cart.get(id) || 0;
    const quantity = Math.max(0, Math.min(99, previousQuantity + Number(button.dataset.adjust)));
    const origin = quantity > previousQuantity && !reducedMotion.matches && typeof button.animate === 'function'
      ? button.getBoundingClientRect()
      : null;
    if (quantity) cart.set(id, quantity);
    else cart.delete(id);
    write('canxu:cart', Object.fromEntries(cart));
    const area = button.closest('#sheet-cart-lines, #cart-lines, #menu-list');
    const hadFocus = document.activeElement === button;
    renderMenu();
    renderCart();
    if (hadFocus) {
      area?.querySelector('[data-item="' + CSS.escape(id) + '"][data-adjust="' + button.dataset.adjust + '"]')?.focus({ preventScroll: true });
    }
    if (origin) animateCartAddition(origin, area?.id === 'sheet-cart-lines');
  }
  if (['checkout-desktop', 'checkout-mobile', 'checkout-sheet'].includes(button.id)) openCheckout();
  if (button.id === 'see-cart') dialog('cart-dialog').showModal();
  if (button.id === 'continue-order') setView('menu');
  if (button.id === 'reload-menu') void loadStore();
  if (button.dataset.order) {
    const cached = history.find((order) => order.id === button.dataset.order);
    if (cached) showReceipt(cached);
    try {
      const { order } = await api('/api/orders/' + encodeURIComponent(button.dataset.order));
      if (currentReceipt === order.id && dialog('receipt-dialog').open) renderReceipt(order);
    } catch (error) { toast(error.message); }
  }
});
$('#menu-search').addEventListener('input', renderMenu);
$('#checkout-form').addEventListener('submit', pay);
dialog('checkout-dialog').addEventListener('cancel', (event) => { if (paying) event.preventDefault(); });
dialog('receipt-dialog').addEventListener('close', () => { currentReceipt = ''; });
setInterval(() => { if (view === 'orders' && !document.hidden) void refreshOrders(); }, 8000);
window.addEventListener('focus', () => {
  if (!paying && !dialog('checkout-dialog').open) void loadStore({ quiet: true });
});
void loadStore();
