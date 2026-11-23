const frame = document.querySelector('#demo-frame');
const image = document.querySelector('#demo-qr');
const placeholder = document.querySelector('#demo-placeholder');
const status = document.querySelector('#demo-status');
const address = document.querySelector('#demo-address');
const copy = document.querySelector('#demo-copy');
let copyTimer;

const messages = {
  starting: '正在建立公网连接，二维码将自动显示。',
  checking: '正在验证公网商家入口。',
  ready: '公网入口已就绪，可分享下方网址。',
  configured: '商家可通过下方网址进入。',
  unverified: '公网入口已分配，仍在验证连接。',
  lan: '当前为局域网入口，请在同一网络下访问。',
  local: '当前仅能在这台电脑上打开商家入口。',
  disconnected: '演示服务已断开，正在重新连接。',
};

function render(data) {
  const message = messages[data.status];
  if (status.textContent !== message) status.textContent = message;
  frame.toggleAttribute('data-idle', data.status === 'local' || data.status === 'disconnected');
  if (data.image && image.getAttribute('src') !== data.image) image.src = data.image;
  if (data.url && address.getAttribute('href') !== data.url) {
    address.href = data.url;
    address.textContent = data.url;
  }
  image.hidden = !data.image;
  placeholder.hidden = Boolean(data.image);
  address.hidden = copy.hidden = !data.url;
}

copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(address.href);
    copy.textContent = '网址已复制';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copy.textContent = '复制入口网址'; }, 2000);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(address);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
});

async function refresh() {
  try {
    const response = await fetch('/api/demo/qr', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch {
    render({ status: 'disconnected' });
  } finally {
    setTimeout(refresh, 2500);
  }
}

void refresh();
