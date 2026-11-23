const $ = (selector, root = document) => root.querySelector(selector);
const loginView = $('#login-view');
const dashboard = $('#dashboard');
const loading = $('#loading');
const dialog = $('#edit-dialog');
const dialogContent = $('#dialog-content');
const storeForm = $('#store-form');
const loginForm = $('#login-form');
const authOptions = $('#auth-options');
const authSwitch = $('#auth-switch');
const customerLink = $('#customer-link');
const money = (cents) => `¥${(cents / 100).toFixed(2)}`;
const oneId = (value) => encodeURIComponent(String(value));
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const timestamps = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const orderTitles = { preparing: '制作中', ready: '待取餐', picked: '已取餐' };
const printTitles = { simulated: '模拟出票', queued: '待打印', printed: '已打印', failed: '打印失败', printing: '打印中' };

let activeTab = 'menu';
let store = { shop: {}, categories: [], items: [] };
let orders = [];
let ordersLoaded = false;
let orderFilter = 'all';
let categoryFilter = 'all';
let chosenLink = '';
let qrLinks = null;
let qrRequestSession = null;
let poll;
let toastTimer;
let adminSession = null;
let authMode = new URLSearchParams(location.search).get('mode') === 'register' ? 'register' : 'login';

async function api(path, method = 'GET', data) {
  const requestSession = adminSession;
  const response = await fetch(`/api/admin${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && requestSession?.authenticated && requestSession === adminSession) {
      authMode = 'login';
      showLogin({ authenticated: false }, '登录已失效，请重新登录。');
    }
    const error = new Error(result.error?.message || '请求未完成，请稍后重试。');
    error.status = response.status;
    throw error;
  }
  return result;
}

function showToast(message, kind = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
}

function showError(form, message) {
  const target = $('.form-error', form);
  target.textContent = message;
  target.hidden = !message;
}

function showLogin(session, message = '') {
  adminSession = session;
  loading.hidden = true;
  dashboard.hidden = true;
  loginView.hidden = false;
  $('#logout-button').hidden = true;
  customerLink.hidden = true;
  if (dialog.open) dialog.close();
  clearInterval(poll);
  orderFilter = 'all';
  categoryFilter = 'all';
  activeTab = 'menu';
  chosenLink = '';
  qrLinks = null;
  $('#qr-content').replaceChildren();
  ordersLoaded = false;
  orders = [];
  store = { shop: {}, categories: [], items: [] };
  loginForm.reset();
  renderAuthForm(session, message);
}

function renderAuthForm(session, message = '') {
  const title = $('#login-title');
  const description = $('#login-description');
  const registering = authMode === 'register';
  loginView.dataset.authMode = authMode;
  if (session && registering) {
    title.textContent = '注册商家账号';
    description.textContent = '使用手机号和密码开通门店。';
  } else if (session) {
    title.textContent = '登录商家工作台';
    description.textContent = '使用手机号和密码登录。';
  } else {
    title.textContent = '商家工作台';
    description.textContent = '连接服务后即可进入商家工作台。';
  }

  const password = loginForm.elements.password;
  password.autocomplete = registering ? 'new-password' : 'current-password';
  password.placeholder = registering ? '请设置至少 8 位密码' : '请输入密码';
  if (registering) password.minLength = 8;
  else password.removeAttribute('minlength');
  $('#login-submit').textContent = registering ? '注册并进入工作台' : '登录';
  loginForm.hidden = authOptions.hidden = authSwitch.hidden = !session;
  authOptions.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === authMode)));
  authSwitch.dataset.mode = registering ? 'login' : 'register';
  authSwitch.textContent = registering ? '去登录' : '去注册';
  $('#auth-panel-title').textContent = registering ? '已有商家账号？' : '第一次使用？';
  $('#auth-panel-description').textContent = registering ? '登录后继续管理门店、菜单与订单。' : '开通门店、录入菜单，生成专属点餐码。';
  $('#login-retry').hidden = Boolean(session);
  showError(loginView, message);
}

async function connectMerchant() {
  try {
    const session = await api('/session');
    if (typeof session.authenticated !== 'boolean') throw new Error('无效的商家连接状态。');
    if (session.authenticated) await showDashboard(session);
    else showLogin(session);
  } catch {
    showLogin(null, '当前无法连接商家服务，请重试。');
  }
}

async function withButton(button, action) {
  button.disabled = true;
  try { await action(); } finally { button.disabled = false; }
}

function empty(title, explanation, action, actionText) {
  return `<div class="empty"><strong>${escape(title)}</strong><p>${escape(explanation)}</p>${action ? `<button class="button button-secondary" type="button" data-action="${action}">${escape(actionText)}</button>` : ''}</div>`;
}

function categoryOptions() {
  return store.categories.map((category) => `<option value="${escape(category.id)}">${escape(category.name)}</option>`).join('');
}

function safeImageUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value, location.href);
    return url.origin === location.origin && /^https?:$/.test(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function renderItems() {
  const display = categoryFilter === 'all' ? store.items : store.items.filter((item) => item.categoryId === categoryFilter);
  if (!display.length) {
    $('#item-list').innerHTML = empty(store.items.length ? '该分类还没有餐品' : '添加第一道餐品', '填写餐品名称和价格即可添加。', 'add-item', '新增餐品');
    return;
  }
  $('#item-list').innerHTML = `<ul class="item-list">${display.map((item) => {
    const category = store.categories.find((entry) => entry.id === item.categoryId)?.name ?? '无分类';
    const imageSource = safeImageUrl(item.imageUrl);
    const photo = imageSource ? `<img class="item-image" src="${escape(imageSource)}" alt="" loading="lazy">` : '<span class="item-image item-image-placeholder" aria-hidden="true">餐品</span>';
    return `<li class="item-row"><div class="item-data">${photo}<div class="item-info"><h3 class="line-title">${escape(item.name)}</h3><div class="item-meta"><span class="price">${money(item.priceCents)}</span><span>${escape(category)}</span><span class="pill ${item.active ? '' : 'off'}">${item.active ? '已上架' : '已下架'}</span></div>${item.description ? `<p class="item-description">${escape(item.description)}</p>` : ''}</div></div><div class="inline-actions"><button class="button button-small" type="button" data-action="toggle-item" data-id="${escape(item.id)}">${item.active ? '下架' : '上架'}</button><button class="button button-small" type="button" data-action="edit-item" data-id="${escape(item.id)}">编辑</button><button class="button button-small delete-action" type="button" data-action="delete-item" data-id="${escape(item.id)}">删除</button></div></li>`;
  }).join('')}</ul>`;
}

function renderMenu() {
  const activeCount = store.items.filter((item) => item.active).length;
  $('#menu-metrics').innerHTML = [['餐品', store.items.length], ['已上架', activeCount], ['分类', store.categories.length]].map(([title, count]) => `<div class="metric"><span>${title}</span><strong>${count}</strong></div>`).join('');
  $('#category-list').innerHTML = store.categories.length ? `<ul class="category-list">${store.categories.map((category) => {
    const count = store.items.filter((item) => item.categoryId === category.id).length;
    return `<li class="category-row"><div><strong class="category-name">${escape(category.name)}</strong><span class="category-count">${count} 道餐品</span></div><div class="inline-actions"><button class="button button-small" type="button" data-action="edit-category" data-id="${escape(category.id)}">编辑</button><button class="button button-small delete-action" type="button" data-action="delete-category" data-id="${escape(category.id)}">删除</button></div></li>`;
  }).join('')}</ul>` : empty('暂无分类', '可按需添加小吃、主食或饮品等分类。');
  const filter = $('#category-filter');
  filter.innerHTML = `<option value="all">全部分类</option>${categoryOptions()}`;
  if (!store.categories.some((category) => category.id === categoryFilter)) categoryFilter = 'all';
  filter.value = categoryFilter;
  renderItems();
}

async function loadStore() {
  const session = adminSession;
  const next = await api('/store');
  if (adminSession !== session) return;
  store = next;
  $('#sidebar-shop').textContent = store.shop.name || '未命名门店';
  customerLink.href = `/?store=${oneId(store.shop.id)}`;
  renderMenu();
}

function fillSettings() {
  for (const field of ['name', 'address', 'announcement']) storeForm.elements[field].value = store.shop[field] || '';
  showError(storeForm, '');
}

function when(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : timestamps.format(date);
}

function renderOrders() {
  const filters = [['all', '全部'], ...Object.entries(orderTitles)];
  $('#order-filters').innerHTML = filters.map(([value, title]) => `<button type="button" data-action="order-filter" data-value="${value}" aria-pressed="${value === orderFilter}">${title} ${value === 'all' ? orders.length : orders.filter((order) => order.status === value).length}</button>`).join('');
  const display = orderFilter === 'all' ? orders : orders.filter((order) => order.status === orderFilter);
  if (!display.length) {
    $('#order-list').innerHTML = empty(ordersLoaded ? '暂无订单' : '正在读取订单', ordersLoaded ? (orderFilter === 'all' ? '顾客完成模拟支付后，订单会显示在这里。' : '当前状态下没有订单。') : '');
    return;
  }
  $('#order-list').innerHTML = `<ul class="order-list">${display.map((order) => {
    const nextStatus = order.status === 'preparing' ? ['ready', '出餐就绪'] : order.status === 'ready' ? ['picked', '确认取餐'] : null;
    const statusButton = nextStatus ? `<button class="button button-primary button-small" type="button" data-action="order-status" data-id="${escape(order.id)}" data-value="${nextStatus[0]}">${nextStatus[1]}</button>` : '';
    return `<li class="order-row"><div class="order-number">取餐号<strong>${escape(order.pickupNumber)}</strong></div><div><div class="order-meta"><span class="pill ${escape(order.status)}">${escape(orderTitles[order.status] || '已接单')}</span><span>${escape(printTitles[order.printStatus] || '待打印')}</span><span>${escape(when(order.createdAt))}</span><strong class="price">${money(order.totalCents)}</strong></div><ul class="order-lines">${order.items.map((item) => `<li class="line-title">${escape(item.name)} × ${escape(item.quantity)}</li>`).join('')}</ul>${order.note ? `<p class="order-note">备注：${escape(order.note)}</p>` : ''}</div><div class="order-actions">${statusButton}<button class="button button-secondary button-small" type="button" data-action="reprint" data-id="${escape(order.id)}">补打标签</button></div></li>`;
  }).join('')}</ul>`;
}

async function loadOrders() {
  const result = await api('/orders');
  const sorted = [...result.orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const changed = JSON.stringify(sorted) !== JSON.stringify(orders);
  orders = sorted;
  if (!ordersLoaded || changed) {
    ordersLoaded = true;
    renderOrders();
  }
}

function qrUrl(url) {
  return `/api/admin/qr?url=${encodeURIComponent(url)}`;
}

function setQrLink(value) {
  chosenLink = value;
  $('#qr-address').value = value;
  const image = $('#store-qr');
  const source = qrUrl(value);
  if (image.getAttribute('src') !== source) image.src = source;
  $('#download-qr').href = source;
  const host = new URL(value).hostname;
  const localOnly = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host);
  let help = localOnly ? '当前二维码仅供本机访问。' : '当前为局域网二维码，手机和电脑须在同一可互访网络。';
  if (value === qrLinks.publicUrl) {
    const publicHelp = {
      checking: '公网地址正在验证，可以先用手机流量试扫。',
      unverified: '公网地址已分配，可以用手机流量试扫。',
    };
    help = publicHelp[qrLinks.publicStatus] ?? '当前为公网二维码，手机可直接扫码点餐。';
  } else if (!qrLinks.publicUrl) {
    help += ' 开启异地演示后，本页会自动切换到公网二维码。';
  }
  $('#qr-help').textContent = help;
}

async function loadLinks() {
  const session = adminSession;
  if (!session?.authenticated || qrRequestSession === session) return;
  qrRequestSession = session;
  const panel = $('#qr-content');
  if (!qrLinks) panel.innerHTML = empty('正在生成点餐码', '');
  try {
    const data = await api('/links');
    if (adminSession !== session) return;
    const links = [...new Set([data.url, ...(data.urls || [])])].filter((url) => {
      if (typeof url !== 'string') return false;
      try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
    });
    if (!links.length) {
      qrLinks = null;
      panel.innerHTML = empty('暂无可用链接', '请确认服务地址后刷新二维码。', 'reload-links', '刷新');
      return;
    }
    const next = { links, publicUrl: data.publicUrl, publicStatus: data.publicStatus };
    if (JSON.stringify(qrLinks) === JSON.stringify(next)) return;

    const initial = qrLinks && qrLinks.publicUrl === next.publicUrl && links.includes(chosenLink) ? chosenLink : links[0];
    if (!qrLinks) {
      panel.innerHTML = `<div class="qr-image-box"><img id="store-qr" width="218" height="218" alt="扫码进入门店点餐页"></div><div><label class="field"><span>选择访问地址</span><select id="qr-option"></select></label><label class="field"><span>顾客点餐链接</span><input id="qr-address" type="url" readonly></label><div class="qr-actions"><button class="button button-primary" type="button" data-action="copy-link">复制链接</button><a id="download-qr" class="button button-secondary" download="餐序-门店点餐码.png">下载二维码</a></div><p id="qr-help" class="qr-help"></p></div>`;
      $('#store-qr').addEventListener('error', () => { $('#qr-help').textContent = '二维码加载失败。请刷新本页，或复制顾客点餐链接。'; });
    }
    if (qrLinks?.links.join('\n') !== links.join('\n')) {
      $('#qr-option').replaceChildren(...links.map(url => new Option(url, url)));
    }
    qrLinks = next;
    $('#qr-option').value = initial;
    setQrLink(initial);
  } catch (error) {
    if (adminSession === session && !qrLinks) panel.innerHTML = empty('二维码暂无数据', error.message, 'reload-links', '重试');
  } finally {
    if (qrRequestSession === session) qrRequestSession = null;
  }
}

async function switchTab(tab) {
  const changed = activeTab !== tab;
  activeTab = tab;
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
    if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-panel]').forEach((panel) => {
    const show = panel.dataset.panel === tab;
    if (show && panel.hidden) panel.classList.add('panel-enter');
    panel.hidden = !show;
  });
  if (changed) window.scrollTo(0, 0);
  if (tab === 'store') fillSettings();
  if (tab === 'orders') {
    renderOrders();
    try { await loadOrders(); }
    catch (error) { $('#order-list').innerHTML = empty('无法读取订单', error.message, 'refresh-orders', '重试'); }
  }
  if (tab === 'qr') await loadLinks();
}

async function showDashboard(session) {
  adminSession = session;
  authMode = 'login';
  try {
    await loadStore();
  } catch {
    if (adminSession === session) showLogin(null, '当前无法读取门店数据，请重试。');
    return;
  }
  if (adminSession !== session) return;
  loginView.hidden = true;
  loading.hidden = true;
  dashboard.hidden = false;
  $('#logout-button').hidden = false;
  customerLink.hidden = false;
  await switchTab('menu');
  clearInterval(poll);
  poll = setInterval(() => {
    if (document.hidden || dashboard.hidden) return;
    if (activeTab === 'orders') loadOrders().catch(() => {});
    if (activeTab === 'qr') void loadLinks();
  }, 6500);
}

function openEdit({ title, fields, actionLabel = '保存', danger = false, submit }) {
  dialogContent.innerHTML = `<div class="dialog-heading"><h2 id="dialog-title">${escape(title)}</h2><button class="button button-link dialog-close" type="button" data-action="close-dialog" aria-label="关闭">×</button></div><form class="dialog-body">${fields}<p class="form-error" role="alert" hidden></p><div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-dialog">取消</button><button class="button ${danger ? 'button-danger' : 'button-primary'}" type="submit">${escape(actionLabel)}</button></div></form>`;
  const form = $('form', dialogContent);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', form);
    if (button.disabled) return;
    showError(form, '');
    try {
      await withButton(button, async () => { await submit(form); if (dialog.open) dialog.close(); });
    } catch (error) { showError(form, error.message); }
  });
  dialog.showModal();
  const field = $('input:not([type="hidden"]),select,textarea', form);
  if (field) field.focus();
  return form;
}

function resetPassword() {
  const form = openEdit({
    title: '重置密码',
    actionLabel: '保存新密码',
    fields: `<label class="field"><span>当前密码</span><input name="currentPassword" type="password" autocomplete="current-password" maxlength="256" required></label>
      <label class="field"><span>新密码</span><input name="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="256" required></label>
      <label class="field"><span>确认新密码</span><input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" maxlength="256" required></label>
      <p class="field-help">新密码至少 8 位。保存后请用新密码重新登录。</p>`,
    async submit(form) {
      const { currentPassword, newPassword, confirmPassword } = form.elements;
      if (newPassword.value !== confirmPassword.value) throw new Error('两次输入的新密码不一致。');
      const session = await api('/password', 'PUT', {
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
      });
      showLogin(session);
      showToast('密码已重置，请用新密码登录');
      loginForm.elements.phone.focus();
    },
  });
  dialog.addEventListener('close', () => form.reset(), { once: true });
}

function editCategory(category) {
  openEdit({
    title: category ? '编辑分类' : '新增分类',
    fields: `<label class="field"><span>分类名称</span><input name="name" required maxlength="24" value="${escape(category?.name)}" placeholder="小吃"></label>`,
    async submit(form) {
      await api(category ? `/categories/${oneId(category.id)}` : '/categories', category ? 'PUT' : 'POST', { name: form.elements.name.value.trim() });
      await loadStore();
      showToast('分类已保存');
    },
  });
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('无法读取图片，请重新选择。'));
    reader.readAsDataURL(file);
  });
}

function parsePrice(input) {
  const value = input.trim();
  if (!/^\d{1,5}(?:\.\d{1,2})?$/.test(value)) throw new Error('请输入有效价格，最多保留两位小数。');
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents < 1) throw new Error('餐品价格需大于 0 元。');
  return cents;
}

function editItem(item) {
  const originalImage = safeImageUrl(item?.imageUrl);
  const form = openEdit({
    title: item ? '编辑餐品' : '新增餐品',
    fields: `<label class="field"><span>餐品名称</span><input name="name" required maxlength="40" value="${escape(item?.name)}" placeholder="例如：香酥炸鸡腿"></label><div class="field-row"><label class="field"><span>价格（元）</span><input name="price" inputmode="decimal" required value="${item ? (item.priceCents / 100).toFixed(2) : ''}"></label><label class="field"><span>分类</span><select name="categoryId"><option value="">无分类</option>${categoryOptions()}</select></label></div><label class="field"><span>餐品描述</span><textarea name="description" rows="2" maxlength="160" placeholder="口味、份量或其他说明">${escape(item?.description)}</textarea></label><label class="field"><span>餐品图片</span><input name="photo" type="file" accept="image/png,image/jpeg,image/webp"><small class="muted">支持 PNG、JPG 或 WebP，最多 2.5 MB。</small></label><div class="image-preview" ${originalImage ? '' : 'hidden'}><img id="item-photo-preview" ${originalImage ? `src="${escape(originalImage)}"` : ''} alt="餐品预览"><button class="button button-link button-small" type="button" id="remove-photo">移除图片</button></div><label class="check"><input name="active" type="checkbox" ${item?.active !== false ? 'checked' : ''}>在顾客菜单上架</label>`,
    async submit(formData) {
      let imageUrl = formData.dataset.keepPhoto === 'true' ? item?.imageUrl || '' : '';
      const file = formData.elements.photo.files[0];
      const priceCents = parsePrice(formData.elements.price.value);
      const name = formData.elements.name.value.trim();
      if (!name) throw new Error('请输入餐品名称。');
      if (file) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2_500_000) throw new Error('请选择不超过 2.5 MB 的 PNG、JPG 或 WebP 图片。');
        const dataUrl = await readDataUrl(file);
        imageUrl = (await api('/upload', 'POST', { dataUrl })).imageUrl;
      }
      const payload = { categoryId: formData.elements.categoryId.value || null, name, priceCents, description: formData.elements.description.value.trim(), imageUrl, active: formData.elements.active.checked };
      await api(item ? `/items/${oneId(item.id)}` : '/items', item ? 'PUT' : 'POST', payload);
      await loadStore();
      showToast('餐品已保存');
    },
  });
  form.dataset.keepPhoto = String(Boolean(originalImage));
  if (item) form.elements.categoryId.value = item.categoryId ?? '';
  else if (categoryFilter !== 'all') form.elements.categoryId.value = categoryFilter;
  const preview = $('.image-preview', form);
  const image = $('img', preview);
  const fileInput = form.elements.photo;
  fileInput.addEventListener('change', async () => {
    showError(form, '');
    const file = fileInput.files[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2_500_000) {
      showError(form, '请选择不超过 2.5 MB 的 PNG、JPG 或 WebP 图片。');
      fileInput.value = '';
      return;
    }
    try {
      const dataUrl = await readDataUrl(file);
      if (fileInput.files[0] !== file) return;
      image.src = dataUrl;
      preview.hidden = false;
    }
    catch (error) { showError(form, error.message); }
  });
  $('#remove-photo', form).addEventListener('click', () => {
    form.dataset.keepPhoto = 'false';
    fileInput.value = '';
    image.removeAttribute('src');
    preview.hidden = true;
  });
}

function confirmDelete(record, kind) {
  const category = kind === 'categories';
  const inUse = category && store.items.some((item) => item.categoryId === record.id);
  if (inUse) { showToast('请先移走或删除分类中的餐品。', 'error'); return; }
  openEdit({
    title: category ? '删除分类' : '删除餐品',
    fields: `<p>确认删除「${escape(record.name)}」吗？</p>`,
    actionLabel: '确认删除',
    danger: true,
    async submit() {
      await api(`/${kind}/${oneId(record.id)}`, 'DELETE');
      await loadStore();
      showToast(category ? '分类已删除' : '餐品已删除');
    },
  });
}

loginView.addEventListener('click', event => {
  const selected = event.target.closest('button[data-mode]');
  if (!selected || selected.dataset.mode === authMode || $('#login-submit').disabled) return;
  authMode = selected.dataset.mode;
  loginForm.elements.password.value = '';
  renderAuthForm(adminSession);
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#login-submit');
  if (loginForm.hidden || button.disabled) return;
  showError(loginView, '');
  const registering = authMode === 'register';
  try {
    await withButton(button, async () => {
      const session = await api(registering ? '/register' : '/login', 'POST', {
        phone: loginForm.elements.phone.value.trim(),
        password: loginForm.elements.password.value,
      });
      loginForm.reset();
      await showDashboard(session);
    });
  } catch (error) {
    showError(loginView, error.message);
  }
});

$('#login-retry').addEventListener('click', (event) => {
  void withButton(event.currentTarget, connectMerchant);
});

$('#logout-button').addEventListener('click', async (event) => {
  try { await withButton(event.currentTarget, async () => { await api('/logout', 'POST'); showLogin({ authenticated: false }); }); }
  catch (error) { showToast(error.message, 'error'); }
});

storeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError(storeForm, '');
  const form = new FormData(storeForm);
  const values = Object.fromEntries([...form.entries()].map(([key, value]) => [key, value.trim()]));
  try {
    await withButton($('button[type="submit"]', storeForm), async () => {
      await api('/shop', 'PUT', values);
      await loadStore();
      fillSettings();
      showToast('门店设置已保存');
    });
  } catch (error) { showError(storeForm, error.message); }
});

document.addEventListener('change', ({ target }) => {
  if (target.id === 'category-filter') { categoryFilter = target.value; renderItems(); }
  if (target.id === 'qr-option') setQrLink(target.value);
});

document.addEventListener('click', async ({ target }) => {
  const tab = target.closest('[data-tab]');
  if (tab) { await switchTab(tab.dataset.tab); return; }
  const button = target.closest('[data-action]');
  if (!button || button.disabled) return;
  const { action, id, value } = button.dataset;
  const item = store.items.find((entry) => entry.id === id);
  const category = store.categories.find((entry) => entry.id === id);
  try {
    if (action === 'close-dialog') { dialog.close(); return; }
    if (action === 'reset-password') { resetPassword(); return; }
    if (action === 'add-category') { editCategory(); return; }
    if (action === 'edit-category' && category) { editCategory(category); return; }
    if (action === 'delete-category' && category) { confirmDelete(category, 'categories'); return; }
    if (action === 'add-item') { editItem(); return; }
    if (action === 'edit-item' && item) { editItem(item); return; }
    if (action === 'delete-item' && item) { confirmDelete(item, 'items'); return; }
    if (action === 'toggle-item' && item) {
      await withButton(button, async () => {
        const { categoryId, name, priceCents, description, imageUrl, active } = item;
        await api(`/items/${oneId(id)}`, 'PUT', { categoryId, name, priceCents, description, imageUrl, active: !active });
        await loadStore();
        showToast(active ? '餐品已下架' : '餐品已上架');
      });
      return;
    }
    if (action === 'order-filter') { orderFilter = value; renderOrders(); return; }
    if (action === 'refresh-orders') { ordersLoaded = false; await withButton(button, loadOrders); return; }
    if (action === 'order-status' || action === 'reprint') {
      const suffix = action === 'reprint' ? '/reprint' : '';
      await withButton(button, async () => {
        await api(`/orders/${oneId(id)}${suffix}`, action === 'reprint' ? 'POST' : 'PATCH', action === 'reprint' ? undefined : { status: value });
        await loadOrders();
        showToast(action === 'reprint' ? '已提交补打，取餐号保持一致' : '订单状态已更新');
      });
      return;
    }
    if (action === 'reload-links') { await loadLinks(); return; }
    if (action === 'copy-link') {
      const address = $('#qr-address');
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(address.value);
        showToast('点餐链接已复制');
      } catch {
        address.focus();
        address.select();
        if (document.execCommand('copy')) showToast('点餐链接已复制');
        else showToast('链接已选中，可长按或使用 Ctrl+C 复制。');
      }
    }
  } catch (error) { showToast(error.message, 'error'); }
});

await connectMerchant();
