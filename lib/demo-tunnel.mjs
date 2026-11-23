import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

function markerPath(dataDir) {
  return resolve(dataDir, 'demo-tunnel.json');
}

function readMarker(dataDir) {
  try {
    return JSON.parse(readFileSync(markerPath(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

export function activeDemoTunnel(dataDir, port) {
  const marker = readMarker(dataDir);
  if (marker?.port !== port || typeof marker.origin !== 'string' ||
      !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(marker.origin) ||
      !Number.isSafeInteger(marker.pid) || marker.pid <= 0 ||
      !['checking', 'ready', 'unverified'].includes(marker.status)) return null;
  try {
    process.kill(marker.pid, 0);
    return marker;
  } catch {
    return null;
  }
}

export function publishDemoTunnel(dataDir, marker) {
  mkdirSync(dataDir, { recursive: true });
  const destination = markerPath(dataDir);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(marker), { flag: 'wx' });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function updateDemoTunnel(dataDir, marker, status) {
  const current = readMarker(dataDir);
  if (current?.pid !== marker.pid || current.origin !== marker.origin) return;
  if (status) publishDemoTunnel(dataDir, { ...marker, status });
  else rmSync(markerPath(dataDir), { force: true });
}
