import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tables = { categories: 'categories', items: 'items', orders: 'orders', printJobs: 'print_jobs' };
const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
export const uploadName = /^\/uploads\/([a-zA-Z0-9_-]+\.(?:png|jpg|webp))$/;

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function openStoreDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(resolve(dataDir, 'ordering.sqlite'));
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS shops (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
      name TEXT NOT NULL, address TEXT NOT NULL, announcement TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
    CREATE TABLE IF NOT EXISTS uploads (
      name TEXT PRIMARY KEY, shop_id TEXT NOT NULL REFERENCES shops(id), mime TEXT NOT NULL, image BLOB NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY) STRICT;
  `);
  const records = {};
  for (const [key, table] of Object.entries(tables)) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      shop_id TEXT NOT NULL REFERENCES shops(id), id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
      PRIMARY KEY (shop_id, id)
    ) STRICT;`);
    records[key] = {
      list: db.prepare(`SELECT id, data FROM ${table} WHERE shop_id = ? ORDER BY rowid`),
      save: db.prepare(`INSERT INTO ${table} (shop_id, id, data) VALUES (?, ?, ?)
        ON CONFLICT(shop_id, id) DO UPDATE SET data = excluded.data`),
      remove: db.prepare(`DELETE FROM ${table} WHERE shop_id = ? AND id = ?`),
    };
  }
  const selectShop = db.prepare('SELECT id, name, address, announcement FROM shops WHERE id = ?');
  const insertShop = db.prepare('INSERT INTO shops (id, account_id, name, address, announcement) VALUES (?, ?, ?, ?, ?)');
  const updateShop = db.prepare('UPDATE shops SET name = ?, address = ?, announcement = ? WHERE id = ?');
  const insertAccount = db.prepare('INSERT INTO accounts (id, phone, password_salt, password_hash) VALUES (?, ?, ?, ?)');
  const selectAccount = db.prepare('SELECT id, password_salt AS passwordSalt, password_hash AS passwordHash FROM accounts WHERE phone = ?');
  const findPassword = db.prepare('SELECT password_salt AS passwordSalt, password_hash AS passwordHash FROM accounts WHERE id = ?');
  const insertSession = db.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)');
  const selectSession = db.prepare(`SELECT sessions.account_id AS accountId, shops.id AS shopId
    FROM sessions JOIN shops ON shops.account_id = sessions.account_id WHERE token_hash = ? AND expires_at > ?`);
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const deleteAccountSessions = db.prepare('DELETE FROM sessions WHERE account_id = ?');
  const deleteExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  const updatePassword = db.prepare('UPDATE accounts SET password_salt = ?, password_hash = ? WHERE id = ? AND password_hash = ?');
  const insertUpload = db.prepare('INSERT INTO uploads (name, shop_id, mime, image) VALUES (?, ?, ?, ?)');
  const selectUpload = db.prepare('SELECT mime, image FROM uploads WHERE name = ?');
  const selectUploadOwner = db.prepare('SELECT shop_id FROM uploads WHERE name = ? AND shop_id = ?');
  const selectOrder = db.prepare('SELECT data FROM orders WHERE shop_id = ? AND id = ?');
  const countWaiting = db.prepare(`SELECT count(*) AS count FROM orders
    WHERE shop_id = ? AND json_extract(data, '$.status') = 'preparing'`);

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = action();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function register({ phone, salt, hash }) {
    return transaction(() => {
      if (selectAccount.get(phone)) return null;
      const accountId = randomUUID();
      const shopId = randomUUID();
      insertAccount.run(accountId, phone, salt, hash);
      insertShop.run(shopId, accountId, '', '', '');
      return accountId;
    });
  }

  function changeStore(shopId, fields, apply) {
    return transaction(() => {
      const shop = selectShop.get(shopId);
      const draft = { shop };
      const previous = {};
      for (const field of fields) {
        const rows = records[field].list.all(shopId);
        previous[field] = new Map(rows.map(row => [row.id, row.data]));
        draft[field] = rows.map(row => JSON.parse(row.data));
      }
      const beforeShop = JSON.stringify(shop);
      const result = apply(draft);
      if (JSON.stringify(shop) !== beforeShop) updateShop.run(shop.name, shop.address, shop.announcement, shopId);
      for (const field of fields) {
        const old = previous[field];
        for (const record of draft[field]) {
          const data = JSON.stringify(record);
          if (old.get(record.id) !== data) records[field].save.run(shopId, record.id, data);
          old.delete(record.id);
        }
        for (const id of old.keys()) records[field].remove.run(shopId, id);
      }
      return result;
    });
  }

  function migrateLegacyStore() {
    const legacyPath = resolve(dataDir, 'store.json');
    if (!existsSync(legacyPath)) return;
    const completed = db.prepare('SELECT name FROM migrations WHERE name = ?');
    const step = 'single-store-json';
    if (completed.get(step)) return;
    const legacy = JSON.parse(readFileSync(legacyPath, 'utf8'));
    if (!legacy.merchantAccount) return;
    const { phone, passwordSalt, passwordHash } = legacy.merchantAccount;
    const shop = legacy.shop;
    transaction(() => {
      if (completed.get(step)) return;
      const accountId = randomUUID();
      insertAccount.run(accountId, phone, passwordSalt, passwordHash);
      insertShop.run(shop.id, accountId, shop.name, shop.address ?? '', shop.announcement ?? '');
      for (const field of Object.keys(tables)) {
        for (const record of legacy[field] ?? []) records[field].save.run(shop.id, record.id, JSON.stringify(record));
      }
      const images = new Set(legacy.items.map(item => uploadName.exec(item.imageUrl)?.[1]).filter(Boolean));
      for (const name of images) {
        const path = resolve(dataDir, 'uploads', name);
        if (existsSync(path)) insertUpload.run(name, shop.id, imageTypes[extname(name)], readFileSync(path));
      }
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(step);
    });
  }

  migrateLegacyStore();
  return {
    register, changeStore,
    account: phone => selectAccount.get(phone),
    password: accountId => findPassword.get(accountId),
    session: token => token && selectSession.get(tokenHash(token), Date.now()),
    addSession(accountId, token, expiresAt, oldToken) {
      transaction(() => {
        if (oldToken) deleteSession.run(tokenHash(oldToken));
        insertSession.run(tokenHash(token), accountId, expiresAt);
      });
    },
    endSession: token => deleteSession.run(tokenHash(token)),
    expireSessions: () => deleteExpiredSessions.run(Date.now()),
    changePassword(accountId, oldHash, salt, hash) {
      return transaction(() => {
        if (!updatePassword.run(salt, hash, accountId, oldHash).changes) return false;
        deleteAccountSessions.run(accountId);
        return true;
      });
    },
    shop: id => selectShop.get(id),
    list: (shopId, field) => records[field].list.all(shopId).map(row => JSON.parse(row.data)),
    order(shopId, id) {
      const row = selectOrder.get(shopId, id);
      return row && JSON.parse(row.data);
    },
    waitingCount: shopId => countWaiting.get(shopId).count,
    upload: name => selectUpload.get(name),
    ownsUpload: (shopId, name) => Boolean(selectUploadOwner.get(name, shopId)),
    addUpload: (shopId, name, mime, image) => insertUpload.run(name, shopId, mime, image),
  };
}
