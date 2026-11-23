import { spawn } from 'node:child_process';
import { setDefaultResultOrder } from 'node:dns';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { publishDemoTunnel, updateDemoTunnel } from '../lib/demo-tunnel.mjs';
import { merchantEntryPath, server, serverReady, setDemoStarting } from '../server.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const dataDir = resolve(process.env.DATA_DIR || resolve(projectDir, 'runtime', 'data'));
const logDir = resolve(projectDir, 'runtime', 'tunnel');
const cloudflared = process.env.CLOUDFLARED_PATH || resolve(logDir, 'portable', 'cloudflared', 'cloudflared.exe');
const logPath = resolve(logDir, 'cloudflared.log');
setDefaultResultOrder('ipv4first');

function openDisplay(origin) {
  const url = new URL('/demo', origin).href;
  console.log(`电脑扫码展示页  ${url}`);
  if (process.platform !== 'win32' || process.env.ORDER_DEMO_OPEN_BROWSER === '0') return;
  const browser = spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], {
    windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore',
  });
  browser.on('error', () => console.log('请在浏览器中打开上面的扫码展示页。'));
  browser.unref();
}

async function fetchDemo(path, origin, signal) {
  const response = await fetch(new URL(path, origin), {
    cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`公网点餐页返回 HTTP ${response.status}`);
    error.retryAfter = Number(response.headers.get('retry-after')) || 0;
    throw error;
  }
  return response;
}

async function watchPublicDemo(origin, signal, reportStatus) {
  const statusDeadline = Date.now() + 160000;
  let status = 'checking';
  for (;;) {
    signal.throwIfAborted();
    let retryAfter = 0;
    try {
      const session = await (await fetchDemo('/api/admin/session', origin, signal)).json();
      if (session.authenticated !== false) throw new Error('公网商家接口未返回预期内容');
      const landing = await fetchDemo(merchantEntryPath, origin, signal);
      if (!(await landing.text()).includes('id="login-form"')) throw new Error('公网商家注册页未返回预期内容');
      if (status !== 'ready') reportStatus('ready');
      status = 'ready';
    } catch (error) {
      signal.throwIfAborted();
      if (status === 'ready' || (status === 'checking' && Date.now() >= statusDeadline)) {
        reportStatus('unverified', error);
        status = 'unverified';
      }
      retryAfter = (error.retryAfter ?? 0) * 1000;
    }
    const interval = status === 'checking' ? 2500 : 12000;
    await delay(Math.max(interval, retryAfter), undefined, { signal });
  }
}

function tunnelAddress(tunnel, signal) {
  return new Promise((resolve, reject) => {
    let output = '';
    let address;
    let registered = false;
    const timer = setTimeout(() => finish(new Error('等待 Cloudflare 公网连接超时')), 60000);
    const abort = () => finish(signal.reason);
    const finish = (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      tunnel.stdout.off('data', scan);
      tunnel.stderr.off('data', scan);
      if (error) reject(error);
      else resolve(address);
    };
    const scan = (chunk) => {
      output = (output + chunk).slice(-4096);
      address ??= output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
      registered ||= output.includes('Registered tunnel connection');
      if (address && registered) finish();
    };
    tunnel.stdout.on('data', scan);
    tunnel.stderr.on('data', scan);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function runTunnel(localOrigin, stopSignal) {
  stopSignal.throwIfAborted();
  if (!existsSync(cloudflared)) throw new Error('未找到 Cloudflare 演示组件');
  mkdirSync(logDir, { recursive: true });
  const log = createWriteStream(logPath, { flags: 'w' });
  log.on('error', error => console.error(`无法写入异地演示日志。${error.message}`));
  const tunnel = spawn(cloudflared, ['tunnel', '--protocol', 'auto', '--url', localOrigin], { windowsHide: true });
  tunnel.stdout.pipe(log, { end: false });
  tunnel.stderr.pipe(log, { end: false });
  const stopped = new AbortController();
  const signal = AbortSignal.any([stopSignal, stopped.signal]);
  tunnel.once('error', error => stopped.abort(error));
  tunnel.once('close', code => stopped.abort(new Error(`Cloudflare 隧道已退出（${code ?? '已停止'}）`)));
  let marker;
  try {
    console.log('正在建立临时公网商家入口…');
    const origin = await tunnelAddress(tunnel, signal);
    const port = Number(new URL(localOrigin).port);
    marker = { origin, port, pid: tunnel.pid, status: 'checking' };
    publishDemoTunnel(dataDir, marker);
    setDemoStarting(false);
    console.log('公网商家入口正在验证。');
    await watchPublicDemo(origin, signal, (status, error) => {
      updateDemoTunnel(dataDir, marker, status);
      if (status === 'ready') console.log(`公网验证通过。分享给商家的网址 ${new URL(merchantEntryPath, origin).href}`);
      else console.error(`公网入口暂不可用，正在重试。${error.message}`);
    });
  } finally {
    tunnel.stdout.unpipe(log);
    tunnel.stderr.unpipe(log);
    log.end();
    if (marker) updateDemoTunnel(dataDir, marker);
    tunnel.kill();
  }
}

const stop = new AbortController();
const requestStop = () => stop.abort();
const needsTunnel = !process.env.PUBLIC_BASE_URL?.trim();
setDemoStarting(needsTunnel);
const terminal = createInterface({ input: process.stdin });
terminal.once('line', requestStop);
terminal.once('close', requestStop);
for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(event, requestStop);

try {
  const port = await serverReady;
  if (!stop.signal.aborted) {
    const localOrigin = `http://127.0.0.1:${port}`;
    openDisplay(localOrigin);
    console.log('扫码期间保持此窗口运行，演示结束后按 Enter 停止。');
    const tunnelTask = needsTunnel ? runTunnel(localOrigin, stop.signal).catch(error => {
      if (!stop.signal.aborted) console.error(`异地演示暂不可用。${error.message}。电脑上的展示页会切换到本地状态。`);
    }).finally(() => setDemoStarting(false)) : Promise.resolve();
    if (!stop.signal.aborted) await new Promise(resolve => stop.signal.addEventListener('abort', resolve, { once: true }));
    await tunnelTask;
  }
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? '点餐端口已被占用。若演示已运行，请使用原来的扫码展示页。' : `点餐服务启动失败。${error.message}`);
  process.exitCode = 1;
} finally {
  terminal.close();
  server.close();
  server.closeAllConnections();
}
