'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
require('dotenv').config();

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '3000', 10);
const SESSION_SECRET = process.env.SESSION_SECRET || 'ili-local-dev-secret-change-me-in-production-2024';

const app = express();
const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'ili.db');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'USER' CHECK(role IN ('USER', 'ADMIN')),
      balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
      national_id TEXT,
      avatar TEXT,
      bio TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('private', 'group', 'channel')),
      title TEXT,
      owner_id INTEGER,
      photo TEXT,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (conversation_id, user_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'system', 'gift')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      emoji TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      card_number TEXT NOT NULL UNIQUE,
      pin_hash TEXT NOT NULL,
      design TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'APPROVED', 'ACTIVE', 'BLOCKED', 'CANCELLED')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'TRANSFER_IN', 'PURCHASE', 'GAME', 'BILL', 'ADJUST')),
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
      note TEXT,
      meta TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_cards_user ON cards(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
  `);

  // Seed gifts (codes: 1 diamond, 2 heart, 3 flower, 4 wine)
  const giftCount = db.prepare('SELECT COUNT(*) as c FROM gifts').get().c;
  if (giftCount === 0) {
    const ins = db.prepare('INSERT INTO gifts (code, name, price, emoji) VALUES (?, ?, ?, ?)');
    ins.run('1', 'الماس / Diamond', 20, '💎');
    ins.run('2', 'قلب / Heart', 10, '❤️');
    ins.run('3', 'گل / Flower', 10, '🌸');
    ins.run('4', 'شراب / Wine', 50, '🍷');
  } else {
    // ensure numeric codes exist for older DBs
    try {
      const has1 = db.prepare(`SELECT 1 FROM gifts WHERE code='1'`).get();
      if (!has1) {
        db.prepare(`DELETE FROM gifts`).run();
        const ins = db.prepare('INSERT INTO gifts (code, name, price, emoji) VALUES (?, ?, ?, ?)');
        ins.run('1', 'الماس / Diamond', 20, '💎');
        ins.run('2', 'قلب / Heart', 10, '❤️');
        ins.run('3', 'گل / Flower', 10, '🌸');
        ins.run('4', 'شراب / Wine', 50, '🍷');
      }
    } catch(e) {}
  }

  // Migrations for users profile fields
  try { db.exec(`ALTER TABLE users ADD COLUMN national_id TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE users ADD COLUMN avatar TEXT`); } catch(e){}
  try { db.exec(`ALTER TABLE users ADD COLUMN bio TEXT`); } catch(e){}

  // Migration for existing databases
  try {
    db.exec(`ALTER TABLE transactions ADD COLUMN meta TEXT`);
  } catch (e) { /* column already exists */ }

  // Default system settings
  const rate = db.prepare(`SELECT value FROM system_settings WHERE key = 'ili_toman_rate'`).get();
  if (!rate) {
    db.prepare(`INSERT INTO system_settings (key, value) VALUES ('ili_toman_rate', '1000')`).run();
  }
  const payCard = db.prepare(`SELECT value FROM system_settings WHERE key = 'payment_card'`).get();
  if (!payCard) {
    db.prepare(`INSERT INTO system_settings (key, value) VALUES ('payment_card', '5022291607098900')`).run();
  }

  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('iliyadavan');
  if (!adminExists) {
    const hash = bcrypt.hashSync('iliyadavan', 12);
    db.prepare(`
      INSERT INTO users (username, password_hash, display_name, role, balance)
      VALUES (?, ?, ?, 'ADMIN', 0)
    `).run('iliyadavan', hash, 'ILI Master Admin');
    console.log('[DB] Master admin created: iliyadavan');
  }
}

initDatabase();
ensureSchema();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: SESSION_SECRET,
  resave: true,
  saveUninitialized: true,
  name: 'ili.sid',
  cookie: {
    httpOnly: true,
    secure: false,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    path: '/'
  }
}));

app.use(express.static(path.join(__dirname, 'public')));


function getTokenFromReq(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) {
    return h.slice(7).trim();
  }
  if (req.headers['x-auth-token']) return String(req.headers['x-auth-token']).trim();
  if (req.query && req.query.token) return String(req.query.token).trim();
  return null;
}

function resolveUserId(req) {
  if (req.session && req.session.userId) return req.session.userId;
  const token = getTokenFromReq(req);
  if (!token) return null;
  try {
    ensureSchema();
    const row = db.prepare('SELECT user_id FROM auth_tokens WHERE token = ?').get(token);
    return row ? row.user_id : null;
  } catch (e) {
    return null;
  }
}

function issueToken(userId) {
  ensureSchema();
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO auth_tokens (token, user_id) VALUES (?, ?)').run(token, userId);
  return token;
}

function requireAuth(req, res, next) {
  const uid = resolveUserId(req);
  if (!uid) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.session.userId = uid; // keep session in sync when token used
  next();
}

function requireAdmin(req, res, next) {
  const uid = resolveUserId(req);
  if (!uid) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.session.userId = uid;
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(uid);
  if (!user || user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function getUserById(id) {
  return db.prepare('SELECT id, username, display_name, role, balance, national_id, avatar, bio, created_at FROM users WHERE id = ?').get(id);
}


function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT,
      owner_id INTEGER,
      photo TEXT,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS gifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      emoji TEXT NOT NULL
    );
  `);
  try { db.exec(`ALTER TABLE transactions ADD COLUMN meta TEXT`); } catch (e) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN national_id TEXT`); } catch (e) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN avatar TEXT`); } catch (e) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN bio TEXT`); } catch (e) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN gold_balance REAL NOT NULL DEFAULT 0`); } catch (e) {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS gold_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      side TEXT NOT NULL,
      grams REAL NOT NULL,
      ili_amount INTEGER NOT NULL,
      gold_price_toman INTEGER NOT NULL,
      ili_price_toman INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const gc = db.prepare('SELECT COUNT(*) AS c FROM gifts').get().c;
  if (gc === 0) {
    const ins = db.prepare('INSERT INTO gifts (code, name, price, emoji) VALUES (?, ?, ?, ?)');
    ins.run('1', 'الماس', 20, '💎');
    ins.run('2', 'قلب', 10, '❤️');
    ins.run('3', 'گل', 10, '🌸');
    ins.run('4', 'شراب', 50, '🍷');
    ins.run('5', 'موشک', 30, '🚀');
    ins.run('6', 'ستاره', 15, '⭐');
  }
  const pr = db.prepare(`SELECT value FROM system_settings WHERE key = 'ili_price_toman'`).get();
  if (!pr) {
    const old = db.prepare(`SELECT value FROM system_settings WHERE key = 'ili_toman_rate'`).get();
    db.prepare(`INSERT INTO system_settings (key, value) VALUES ('ili_price_toman', ?)`).run(old?.value || '1000');
  }
}

function audit(actorId, action, details) {
  try {
    db.prepare('INSERT INTO audit_logs (actor_user_id, action, details) VALUES (?, ?, ?)').run(
      actorId || null,
      action,
      typeof details === 'string' ? details : JSON.stringify(details || {})
    );
  } catch (e) {
    console.error('[AUDIT] Failed to write audit log:', e.message);
  }
}

function generateCardNumber() {
  let attempts = 0;
  while (attempts < 50) {
    const suffix = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
    const number = '305064' + suffix;
    const exists = db.prepare('SELECT id FROM cards WHERE card_number = ?').get(number);
    if (!exists) return number;
    attempts++;
  }
  throw new Error('Could not generate unique card number');
}

function isPositiveInteger(val) {
  const n = Number(val);
  return Number.isInteger(n) && n > 0;
}

// ========== AUTH ==========

app.post('/api/register', (req, res) => {
  try {
    const { displayName, username, password } = req.body || {};

    if (!displayName || typeof displayName !== 'string' || displayName.trim().length < 1 || displayName.trim().length > 50) {
      return res.status(400).json({ error: 'Display name must be 1-50 characters' });
    }
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: 'Username is required' });
    }
    const uname = username.trim();
    if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(uname)) {
      return res.status(400).json({ error: 'Username must be 3-30 characters (letters, numbers, _, ., -)' });
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
    if (existing) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    const hash = bcrypt.hashSync(password, 12);
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, display_name, role, balance)
      VALUES (?, ?, ?, 'USER', 0)
    `).run(uname, hash, displayName.trim());

    audit(info.lastInsertRowid, 'REGISTER', { username: uname });
    res.json({ message: 'Account created successfully.' });
  } catch (err) {
    console.error('[REGISTER]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username).trim());
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.save((err) => {
      if (err) {
        console.error('[LOGIN] Session save error:', err);
        return res.status(500).json({ error: 'Something went wrong. Please try again.' });
      }
      audit(user.id, 'LOGIN', { username: user.username });
      let token = null;
      try { token = issueToken(user.id); } catch (e) { console.error('[TOKEN]', e); }
      res.json({
        message: 'Signed in successfully',
        token: token,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          role: user.role
        }
      });
    });
  } catch (err) {
    console.error('[LOGIN]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/logout', (req, res) => {
  const uid = req.session?.userId;
  req.session.destroy((err) => {
    if (err) {
      console.error('[LOGOUT]', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
    if (uid) audit(uid, 'LOGOUT', {});
    res.json({ message: 'Signed out successfully' });
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  try {
    const user = getUserById(req.session.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const card = db.prepare(`
      SELECT id, card_number, design, status, created_at
      FROM cards WHERE user_id = ?
    `).get(user.id);

    const isMasterAdmin = user.username === 'iliyadavan' && user.role === 'ADMIN';

    res.json({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      balance: isMasterAdmin ? null : user.balance,
      isMasterAdmin,
      balanceDisplay: isMasterAdmin ? '∞ ILI' : `${user.balance.toLocaleString()} ILI`,
      card: card || null,
      nationalId: user.national_id || '',
      avatar: user.avatar || null,
      bio: user.bio || '',
      createdAt: user.created_at
    });
  } catch (err) {
    console.error('[ME]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ========== TRANSACTIONS / OVERVIEW ==========

app.get('/api/transactions', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, type, amount, status, note, created_at
      FROM transactions
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(req.session.userId);
    res.json({ transactions: rows });
  } catch (err) {
    console.error('[TRANSACTIONS]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ========== CARD ==========

app.post('/api/card/order', requireAuth, (req, res) => {
  try {
    const { design, pin } = req.body || {};
    const validDesigns = ['Random', 'Girl', 'Boy', 'Male', 'Female'];

    if (!design || !validDesigns.includes(design)) {
      return res.status(400).json({ error: 'Please select a valid card design' });
    }
    if (!pin || !/^\d{4}$/.test(String(pin))) {
      return res.status(400).json({ error: 'PIN must be exactly 4 numeric digits' });
    }

    const existing = db.prepare('SELECT id FROM cards WHERE user_id = ?').get(req.session.userId);
    if (existing) {
      return res.status(400).json({ error: 'You already have a card' });
    }

    const cardNumber = generateCardNumber();
    const pinHash = bcrypt.hashSync(String(pin), 12);

    db.prepare(`
      INSERT INTO cards (user_id, card_number, pin_hash, design, status)
      VALUES (?, ?, ?, ?, 'PENDING')
    `).run(req.session.userId, cardNumber, pinHash, design);

    audit(req.session.userId, 'CARD_ORDER', { design, cardNumber });
    res.json({
      message: 'Card order submitted.',
      card: {
        card_number: cardNumber,
        design,
        status: 'PENDING'
      }
    });
  } catch (err) {
    console.error('[CARD ORDER]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ========== MONEY ==========

app.post('/api/transfer', requireAuth, (req, res) => {
  try {
    const { recipientUsername, amount } = req.body || {};
    if (!recipientUsername || typeof recipientUsername !== 'string') {
      return res.status(400).json({ error: 'Recipient username is required' });
    }
    if (!isPositiveInteger(amount)) {
      return res.status(400).json({ error: 'Amount must be a positive integer' });
    }
    const amt = Number(amount);
    if (amt < 1) {
      return res.status(400).json({ error: 'Amount must be at least 1 ILI' });
    }
    const fee = Math.floor(amt * 0.05); // 5% fee
    const receiveAmt = amt - fee;
    if (receiveAmt < 1) {
      return res.status(400).json({ error: 'Amount too small after 5% fee' });
    }
    const recipientName = recipientUsername.trim();

    const sender = getUserById(req.session.userId);
    if (!sender) return res.status(401).json({ error: 'User not found' });

    if (sender.username.toLowerCase() === recipientName.toLowerCase()) {
      return res.status(400).json({ error: 'You cannot transfer to yourself' });
    }

    const recipient = db.prepare('SELECT * FROM users WHERE username = ?').get(recipientName);
    if (!recipient) {
      return res.status(400).json({ error: 'Recipient not found' });
    }

    const isMaster = sender.username === 'iliyadavan' && sender.role === 'ADMIN';

    const transferTx = db.transaction(() => {
      if (!isMaster) {
        const fresh = db.prepare('SELECT balance FROM users WHERE id = ?').get(sender.id);
        if (fresh.balance < amt) {
          throw new Error('INSUFFICIENT');
        }
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amt, sender.id);
      }

      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(receiveAmt, recipient.id);

      const meta = JSON.stringify({ fee, receiveAmount: receiveAmt });

      db.prepare(`
        INSERT INTO transactions (user_id, type, amount, status, note, meta)
        VALUES (?, 'TRANSFER', ?, 'APPROVED', ?, ?)
      `).run(sender.id, amt, `To @${recipient.username} (fee ${fee} ILI)`, meta);

      db.prepare(`
        INSERT INTO transactions (user_id, type, amount, status, note, meta)
        VALUES (?, 'TRANSFER_IN', ?, 'APPROVED', ?, ?)
      `).run(recipient.id, receiveAmt, `From @${sender.username}`, meta);
    });

    try {
      transferTx();
    } catch (e) {
      if (e.message === 'INSUFFICIENT') {
        return res.status(400).json({ error: 'Insufficient balance' });
      }
      throw e;
    }

    audit(sender.id, 'TRANSFER', {
      to: recipient.username,
      amount: amt,
      fee,
      received: receiveAmt
    });

    try { bumpPriceIndex(0.002 + Math.min(0.01, amt / 100000)); } catch {}
    res.json({
      message: 'Transfer completed.',
      fee,
      received: receiveAmt
    });
  } catch (err) {
    console.error('[TRANSFER]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Buy ILI (deposit) or Sell ILI (withdrawal)
app.post('/api/demo-request', requireAuth, (req, res) => {
  try {
    ensureSchema();
    const { type, amount, bankCard } = req.body || {};
    if (!['DEPOSIT', 'WITHDRAWAL'].includes(type)) {
      return res.status(400).json({ error: 'Invalid request type' });
    }
    if (!isPositiveInteger(amount)) {
      return res.status(400).json({ error: 'Amount must be a positive integer' });
    }
    const amt = Number(amount);
    const user = getUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const rate = getIliPriceToman();
    const toman = amt * rate;

    let note = '';
    let meta = {};

    if (type === 'DEPOSIT') {
      // Buy ILI
      const payCardRow = db.prepare(`SELECT value FROM system_settings WHERE key = 'payment_card'`).get();
      const payCard = payCardRow?.value || '5022291607098900';
      note = `Buy ${amt} ILI — Pay ${toman.toLocaleString()} Toman to ${payCard}`;
      meta = { toman, rate, paymentCard: payCard, direction: 'buy' };
    } else {
      // Sell ILI — require bank card
      if (!bankCard || typeof bankCard !== 'string' || !/^\d{16}$/.test(bankCard.replace(/[\s-]/g, ''))) {
        return res.status(400).json({ error: 'Valid 16-digit bank card number is required for selling ILI' });
      }
      const cleanCard = bankCard.replace(/[\s-]/g, '');
      const isMaster = user.username === 'iliyadavan' && user.role === 'ADMIN';
      if (!isMaster && user.balance < amt) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }
      note = `Sell ${amt} ILI — Receive ~${toman.toLocaleString()} Toman`;
      meta = { toman, rate, sellerCard: cleanCard, direction: 'sell' };
    }

    db.prepare(`
      INSERT INTO transactions (user_id, type, amount, status, note, meta)
      VALUES (?, ?, ?, 'PENDING', ?, ?)
    `).run(user.id, type, amt, note, JSON.stringify(meta));

    // Price impact immediately on request (supply/demand) — must always run
    let newPrice = getIliPriceToman();
    try {
      if (type === 'DEPOSIT') newPrice = applyBuyPriceImpact(amt);
      if (type === 'WITHDRAWAL') newPrice = applySellPriceImpact(amt);
    } catch (e) { console.error('[PRICE]', e); }
    // re-read from DB to be sure
    newPrice = getIliPriceToman();
    try { economyCache.at = 0; newsCache.clear(); } catch (e2) {}

    audit(user.id, type + '_REQUEST', { amount: amt, meta, newPrice });
    res.json({
      message: 'Request submitted. ILI price now: ' + newPrice + ' Toman',
      toman: amt * newPrice,
      rate: newPrice,
      note,
      iliTomanRate: newPrice,
      iliPriceToman: newPrice
    });
  } catch (err) {
    console.error('[DEMO REQUEST]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Public config for frontend (rate + payment card)
// ILI price: absolute Toman in DB
// every 10 ILI bought => +50 Toman
// every 5 ILI sold    => -40 Toman
function getIliPriceToman() {
  try {
    let row = db.prepare(`SELECT value FROM system_settings WHERE key = 'ili_price_toman'`).get();
    if (!row) {
      // migrate from old key if exists
      const old = db.prepare(`SELECT value FROM system_settings WHERE key = 'ili_toman_rate'`).get();
      const start = parseInt(old?.value || '1000', 10) || 1000;
      db.prepare(`INSERT INTO system_settings (key, value) VALUES ('ili_price_toman', ?)`).run(String(start));
      return start;
    }
    const n = parseInt(row.value, 10);
    return Number.isFinite(n) && n > 0 ? n : 1000;
  } catch (e) {
    console.error('[getIliPriceToman]', e);
    return 1000;
  }
}

function setIliPriceToman(price) {
  const p = Math.max(100, Math.round(Number(price) || 1000));
  try {
    db.prepare(`INSERT INTO system_settings (key, value) VALUES ('ili_price_toman', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(p));
  } catch (e) {
    try {
      const exists = db.prepare(`SELECT 1 FROM system_settings WHERE key = 'ili_price_toman'`).get();
      if (exists) db.prepare(`UPDATE system_settings SET value = ? WHERE key = 'ili_price_toman'`).run(String(p));
      else db.prepare(`INSERT INTO system_settings (key, value) VALUES ('ili_price_toman', ?)`).run(String(p));
    } catch (e2) { console.error('[setIliPriceToman]', e2); }
  }
  try {
    const legacy = db.prepare(`SELECT 1 FROM system_settings WHERE key = 'ili_toman_rate'`).get();
    if (legacy) db.prepare(`UPDATE system_settings SET value = ? WHERE key = 'ili_toman_rate'`).run(String(p));
    else db.prepare(`INSERT INTO system_settings (key, value) VALUES ('ili_toman_rate', ?)`).run(String(p));
  } catch (e3) {}
  console.log('[ILI PRICE SET]', p, 'TOMAN');
  return p;
}

function applyBuyPriceImpact(iliAmount) {
  // every 10 ILI buy => +50 Toman  => +5 Toman per ILI
  const amt = Number(iliAmount) || 0;
  const cur = getIliPriceToman();
  if (amt <= 0) return cur;
  const delta = Math.round((amt / 10) * 50);
  const next = cur + Math.max(1, delta);
  console.log('[PRICE BUY]', amt, 'ILI => +', delta, '=>', next);
  try { economyCache.at = 0; } catch (e) {}
  return setIliPriceToman(next);
}

function applySellPriceImpact(iliAmount) {
  // every 5 ILI sell => -40 Toman => -8 Toman per ILI
  const amt = Number(iliAmount) || 0;
  const cur = getIliPriceToman();
  if (amt <= 0) return cur;
  const delta = Math.round((amt / 5) * 40);
  const next = Math.max(100, cur - Math.max(1, delta));
  console.log('[PRICE SELL]', amt, 'ILI => -', delta, '=>', next);
  try { economyCache.at = 0; } catch (e) {}
  return setIliPriceToman(next);
}

/** Adjust ILI when USDT (toman) moves — mild link to tether/btc */
function applyCryptoLinkToIli(usdtToman, btcUsd) {
  try {
    // reject garbage tether readings (tgju sometimes returns junk)
    if (!usdtToman || usdtToman < 10000 || usdtToman > 50000000) return getIliPriceToman();
    let row = db.prepare(`SELECT value FROM system_settings WHERE key = 'last_usdt_toman'`).get();
    const prev = row ? parseFloat(row.value) : 0;
    if (!prev || prev <= 0) {
      const exists = db.prepare(`SELECT 1 FROM system_settings WHERE key = 'last_usdt_toman'`).get();
      if (exists) db.prepare(`UPDATE system_settings SET value = ? WHERE key = 'last_usdt_toman'`).run(String(usdtToman));
      else db.prepare(`INSERT INTO system_settings (key, value) VALUES ('last_usdt_toman', ?)`).run(String(usdtToman));
      if (btcUsd) {
        const be = db.prepare(`SELECT 1 FROM system_settings WHERE key = 'last_btc_usd'`).get();
        if (be) db.prepare(`UPDATE system_settings SET value = ? WHERE key = 'last_btc_usd'`).run(String(btcUsd));
        else db.prepare(`INSERT INTO system_settings (key, value) VALUES ('last_btc_usd', ?)`).run(String(btcUsd));
      }
      return getIliPriceToman();
    }
    const pctUsdt = (usdtToman - prev) / prev;
    let pctBtc = 0;
    if (btcUsd) {
      const br = db.prepare(`SELECT value FROM system_settings WHERE key = 'last_btc_usd'`).get();
      const prevB = br ? parseFloat(br.value) : 0;
      if (prevB > 0) pctBtc = (btcUsd - prevB) / prevB;
      const be = db.prepare(`SELECT 1 FROM system_settings WHERE key = 'last_btc_usd'`).get();
      if (be) db.prepare(`UPDATE system_settings SET value = ? WHERE key = 'last_btc_usd'`).run(String(btcUsd));
      else db.prepare(`INSERT INTO system_settings (key, value) VALUES ('last_btc_usd', ?)`).run(String(btcUsd));
    }
    // 30% weight USDT + 10% BTC of the percent move applied to ILI
    const blended = pctUsdt * 0.3 + pctBtc * 0.1;
    const cur = getIliPriceToman();
    if (Math.abs(blended) < 0.0005) {
      db.prepare(`UPDATE system_settings SET value = ? WHERE key = 'last_usdt_toman'`).run(String(usdtToman));
      return cur;
    }
    const next = Math.max(100, Math.round(cur * (1 + blended)));
    db.prepare(`UPDATE system_settings SET value = ? WHERE key = 'last_usdt_toman'`).run(String(usdtToman));
    if (next !== cur) {
      console.log('[PRICE CRYPTO]', { pctUsdt, pctBtc, cur, next });
      economyCache.at = 0;
      return setIliPriceToman(next);
    }
    return cur;
  } catch (e) {
    console.error('[CRYPTO LINK]', e);
    return getIliPriceToman();
  }
}


function computeIliPrice() {
  const rate = getIliPriceToman();
  const base = 1000;
  const change = ((rate - base) / base) * 100;
  let buys = 0, sells = 0;
  try {
    buys = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM transactions WHERE type='DEPOSIT' AND status='APPROVED'`).get()?.v || 0;
    sells = db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM transactions WHERE type='WITHDRAWAL' AND status='APPROVED'`).get()?.v || 0;
  } catch {}
  return {
    iliTomanRate: rate,
    baseRate: base,
    changePercent: Math.round(change * 10) / 10,
    factors: { rule: 'buy:+50 per 10 ILI | sell:-40 per 5 ILI', buysTotal: buys, sellsTotal: sells },
    volume7d: buys + sells,
    supply: 0
  };
}

function bumpPriceIndex() { return 0; }

app.get('/api/config', (req, res) => {
  try {
    const price = computeIliPrice();
    const cardRow = db.prepare(`SELECT value FROM system_settings WHERE key = 'payment_card'`).get();
    res.json({
      iliTomanRate: price.iliTomanRate,
      paymentCard: cardRow?.value || '5022291607098900',
      price
    });
  } catch (err) {
    res.json({ iliTomanRate: 1000, paymentCard: '5022291607098900' });
  }
});

app.get('/api/price', (req, res) => {
  try {
    res.json(computeIliPrice());
  } catch (err) {
    res.status(500).json({ error: 'Price unavailable' });
  }
});

// ========== ADMIN ==========

app.post('/api/admin/set-ili-price', requireAdmin, (req, res) => {
  try {
    const price = Number((req.body || {}).price);
    if (!Number.isFinite(price) || price < 100) {
      return res.status(400).json({ error: 'قیمت نامعتبر (حداقل ۱۰۰ تومان)' });
    }
    const p = setIliPriceToman(price);
    try { economyCache.at = 0; } catch (e) {}
    res.json({ message: 'قیمت ILI تنظیم شد', iliTomanRate: p, unit: 'تومان' });
  } catch (err) {
    res.status(500).json({ error: 'خطا' });
  }
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT id, username, display_name, role, balance, created_at
      FROM users
      ORDER BY id ASC
    `).all();
    res.json({ users });
  } catch (err) {
    console.error('[ADMIN USERS]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/admin/cards', requireAdmin, (req, res) => {
  try {
    const cards = db.prepare(`
      SELECT c.id, c.card_number, c.design, c.status, c.created_at,
             u.id AS user_id, u.username, u.display_name
      FROM cards c
      JOIN users u ON u.id = c.user_id
      ORDER BY c.created_at DESC
    `).all();
    res.json({ cards });
  } catch (err) {
    console.error('[ADMIN CARDS]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/admin/card-status', requireAdmin, (req, res) => {
  try {
    const { cardId, status } = req.body || {};
    const valid = ['PENDING', 'APPROVED', 'ACTIVE', 'BLOCKED', 'CANCELLED'];
    if (!cardId || !valid.includes(status)) {
      return res.status(400).json({ error: 'Invalid card status update' });
    }

    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
    if (!card) {
      return res.status(404).json({ error: 'Card not found' });
    }

    db.prepare('UPDATE cards SET status = ? WHERE id = ?').run(status, cardId);
    audit(req.session.userId, 'CARD_STATUS', {
      cardId,
      cardNumber: card.card_number,
      newStatus: status
    });
    res.json({ message: 'Card status updated.' });
  } catch (err) {
    console.error('[ADMIN CARD STATUS]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/admin/adjust', requireAdmin, (req, res) => {
  try {
    const { userId, delta } = req.body || {};
    if (!userId || !Number.isInteger(Number(delta)) || Number(delta) === 0) {
      return res.status(400).json({ error: 'Invalid adjustment' });
    }
    const d = Number(delta);

    const target = getUserById(userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (target.username === 'iliyadavan') {
      return res.status(400).json({ error: 'Cannot adjust master admin balance' });
    }

    const adjustTx = db.transaction(() => {
      const fresh = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
      const newBal = fresh.balance + d;
      if (newBal < 0) {
        throw new Error('NEGATIVE');
      }
      db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBal, userId);
      db.prepare(`
        INSERT INTO transactions (user_id, type, amount, status, note)
        VALUES (?, 'ADJUST', ?, 'APPROVED', ?)
      `).run(userId, Math.abs(d), d > 0 ? `Admin +${d} ILI` : `Admin ${d} ILI`);
    });

    try {
      adjustTx();
    } catch (e) {
      if (e.message === 'NEGATIVE') {
        return res.status(400).json({ error: 'Balance cannot become negative' });
      }
      throw e;
    }

    audit(req.session.userId, 'BALANCE_ADJUST', {
      targetUserId: userId,
      targetUsername: target.username,
      delta: d
    });
    res.json({ message: 'Balance updated.' });
  } catch (err) {
    console.error('[ADMIN ADJUST]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT t.id, t.type, t.amount, t.status, t.note, t.meta, t.created_at,
             u.username, u.display_name
      FROM transactions t
      JOIN users u ON u.id = t.user_id
      ORDER BY t.created_at DESC
      LIMIT 100
    `).all();
    // Parse meta for frontend
    const transactions = rows.map(r => {
      let meta = null;
      try { if (r.meta) meta = JSON.parse(r.meta); } catch {}
      return { ...r, meta };
    });
    res.json({ transactions });
  } catch (err) {
    console.error('[ADMIN TX]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/admin/audit', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.id, a.action, a.details, a.created_at,
             u.username AS actor_username, u.display_name AS actor_display_name
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.actor_user_id
      ORDER BY a.created_at DESC
      LIMIT 100
    `).all();
    res.json({ logs: rows });
  } catch (err) {
    console.error('[ADMIN AUDIT]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/admin/transaction-status', requireAdmin, (req, res) => {
  try {
    const { transactionId, status } = req.body || {};
    const valid = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];
    if (!transactionId || !valid.includes(status)) {
      return res.status(400).json({ error: 'Invalid transaction status' });
    }

    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (tx.status !== 'PENDING') {
      return res.status(400).json({ error: 'Only pending transactions can be updated' });
    }

    const updateTx = db.transaction(() => {
      if (status === 'APPROVED') {
        if (tx.type === 'DEPOSIT') {
          db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(tx.amount, tx.user_id);
        } else if (tx.type === 'WITHDRAWAL') {
          const user = db.prepare('SELECT balance, username, role FROM users WHERE id = ?').get(tx.user_id);
          const isMaster = user.username === 'iliyadavan' && user.role === 'ADMIN';
          if (!isMaster && user.balance < tx.amount) {
            throw new Error('INSUFFICIENT');
          }
          if (!isMaster) {
            db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(tx.amount, tx.user_id);
          }
        }
      }
      db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run(status, transactionId);
    });

    try {
      updateTx();
    } catch (e) {
      if (e.message === 'INSUFFICIENT') {
        return res.status(400).json({ error: 'User has insufficient balance for withdrawal approval' });
      }
      throw e;
    }

    if (status === 'APPROVED') {
      try {
        // price already moved on request — do not double-apply on approve
      } catch {}
    }
    audit(req.session.userId, 'TX_STATUS', {
      transactionId,
      newStatus: status,
      type: tx.type
    });
    res.json({ message: 'Transaction status updated.' });
  } catch (err) {
    console.error('[ADMIN TX STATUS]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ========== ADMIN: impersonate + reset PIN + full user ==========
app.get('/api/admin/user/:id', requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid user id' });
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const card = db.prepare(`SELECT id, card_number, design, status, created_at FROM cards WHERE user_id = ?`).get(u.id);
    let txs = [];
    try {
      txs = db.prepare(`SELECT id, type, amount, status, note, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 30`).all(u.id);
    } catch (e) {}
    res.json({
      user: {
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        role: u.role,
        balance: u.balance,
        nationalId: u.national_id || '',
        bio: u.bio || '',
        avatar: u.avatar || null,
        createdAt: u.created_at,
        hasPin: !!card
      },
      card: card || null,
      transactions: txs
    });
  } catch (err) {
    console.error('[ADMIN USER]', err);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

app.post('/api/admin/reset-pin', requireAdmin, (req, res) => {
  try {
    const { userId, newPin } = req.body || {};
    if (!userId || !/^\d{4}$/.test(String(newPin || ''))) {
      return res.status(400).json({ error: 'userId and 4-digit newPin required' });
    }
    const card = db.prepare('SELECT id FROM cards WHERE user_id = ?').get(userId);
    if (!card) return res.status(404).json({ error: 'User has no card' });
    const hash = bcrypt.hashSync(String(newPin), 12);
    db.prepare('UPDATE cards SET pin_hash = ? WHERE user_id = ?').run(hash, userId);
    audit(req.session.userId, 'ADMIN_RESET_PIN', { targetUserId: userId });
    res.json({ message: 'PIN reset successfully. (Original PIN cannot be recovered — bcrypt)' });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/admin/impersonate', requireAdmin, (req, res) => {
  try {
    const { userId } = req.body || {};
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.username === 'iliyadavan') {
      return res.status(400).json({ error: 'Cannot impersonate master admin' });
    }
    const adminId = req.session.userId;
    req.session.impersonatorId = adminId;
    req.session.userId = target.id;
    req.session.role = target.role;
    req.session.save((err) => {
      if (err) {
        console.error('[IMPERSONATE SAVE]', err);
        return res.status(500).json({ error: 'Session save failed' });
      }
      audit(adminId, 'IMPERSONATE', { as: target.username });
      res.json({
        message: 'Now logged in as ' + target.username,
        user: { id: target.id, username: target.username, displayName: target.display_name }
      });
    });
  } catch (err) {
    console.error('[IMPERSONATE]', err);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

app.post('/api/admin/stop-impersonate', requireAuth, (req, res) => {
  try {
    if (!req.session.impersonatorId) {
      return res.status(400).json({ error: 'Not impersonating' });
    }
    const back = req.session.impersonatorId;
    req.session.userId = back;
    req.session.impersonatorId = null;
    const u = getUserById(back);
    req.session.role = u?.role;
    res.json({ message: 'Returned to admin account' });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ========== SCANNER (pay by card barcode) ==========
function findCardByNumber(cardNumber) {
  const clean = String(cardNumber || '').replace(/[\s-]/g, '');
  return db.prepare(`
    SELECT c.card_number, c.status, c.design, u.id AS user_id, u.username, u.display_name, u.avatar
    FROM cards c
    JOIN users u ON u.id = c.user_id
    WHERE c.card_number = ?
  `).get(clean);
}

app.post('/api/scanner/lookup', requireAuth, (req, res) => {
  try {
    const cardNumber = String((req.body && req.body.card) || req.query.card || '').replace(/[\s-]/g, '');
    if (!/^\d{12}$/.test(cardNumber)) {
      return res.status(400).json({ error: 'شماره کارت باید ۱۲ رقم باشد (مثال: 305064123456)' });
    }
    const row = findCardByNumber(cardNumber);
    if (!row) return res.status(404).json({ error: 'کارتی با این شماره پیدا نشد' });
    if (row.user_id === req.session.userId) {
      return res.status(400).json({ error: 'نمی‌توانید به کارت خودتان ارسال کنید' });
    }
    if (row.status === 'BLOCKED' || row.status === 'CANCELLED') {
      return res.status(400).json({ error: 'این کارت مسدود یا لغو شده است' });
    }
    res.json({
      cardNumber: row.card_number,
      design: row.design,
      status: row.status,
      user: { id: row.user_id, username: row.username, displayName: row.display_name, avatar: row.avatar }
    });
  } catch (err) {
    console.error('[SCAN LOOKUP]', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/api/scanner/lookup', requireAuth, (req, res) => {
  req.body = { card: req.query.card };
  // reuse POST logic via internal call pattern
  const cardNumber = String(req.query.card || '').replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(cardNumber)) {
    return res.status(400).json({ error: 'شماره کارت باید ۱۲ رقم باشد' });
  }
  const row = findCardByNumber(cardNumber);
  if (!row) return res.status(404).json({ error: 'کارتی با این شماره پیدا نشد' });
  if (row.user_id === req.session.userId) {
    return res.status(400).json({ error: 'نمی‌توانید به کارت خودتان ارسال کنید' });
  }
  if (row.status === 'BLOCKED' || row.status === 'CANCELLED') {
    return res.status(400).json({ error: 'این کارت مسدود یا لغو شده است' });
  }
  res.json({
    cardNumber: row.card_number,
    design: row.design,
    status: row.status,
    user: { id: row.user_id, username: row.username, displayName: row.display_name, avatar: row.avatar }
  });
});

app.post('/api/scanner/pay', requireAuth, (req, res) => {
  try {
    const { cardNumber, amount, pin } = req.body || {};
    const cleanCard = String(cardNumber || '').replace(/[\s-]/g, '');
    if (!/^\d{12}$/.test(cleanCard)) {
      return res.status(400).json({ error: 'شماره کارت نامعتبر است' });
    }
    if (!isPositiveInteger(amount)) {
      return res.status(400).json({ error: 'مبلغ باید عدد مثبت باشد' });
    }
    const amt = Number(amount);
    const sender = getUserById(req.session.userId);
    const isMaster = sender.username === 'iliyadavan' && sender.role === 'ADMIN';

    // PIN required only if sender has a card (master admin can skip)
    const senderCard = db.prepare('SELECT pin_hash FROM cards WHERE user_id = ?').get(req.session.userId);
    if (senderCard) {
      if (!/^\d{4}$/.test(String(pin || ''))) {
        return res.status(400).json({ error: 'PIN باید ۴ رقم باشد' });
      }
      if (!bcrypt.compareSync(String(pin), senderCard.pin_hash)) {
        return res.status(400).json({ error: 'PIN اشتباه است' });
      }
    } else if (!isMaster) {
      return res.status(400).json({ error: 'برای استفاده از اسکنر باید کارت داشته باشید' });
    }

    const target = findCardByNumber(cleanCard);
    if (!target) return res.status(404).json({ error: 'کارت پیدا نشد' });
    if (target.user_id === req.session.userId) {
      return res.status(400).json({ error: 'نمی‌توانید به خودتان بفرستید' });
    }
    if (target.status === 'BLOCKED' || target.status === 'CANCELLED') {
      return res.status(400).json({ error: 'کارت مقصد مسدود است' });
    }

    const fee = Math.floor(amt * 0.05);
    const receiveAmt = amt - fee;
    if (receiveAmt < 1) return res.status(400).json({ error: 'مبلغ بعد از کارمزد خیلی کم است' });

    const payTx = db.transaction(() => {
      if (!isMaster) {
        const fresh = db.prepare('SELECT balance FROM users WHERE id = ?').get(sender.id);
        if (fresh.balance < amt) throw new Error('INSUFFICIENT');
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amt, sender.id);
      }
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(receiveAmt, target.user_id);
      const meta = JSON.stringify({ fee, receiveAmount: receiveAmt, via: 'scanner', card: cleanCard });
      db.prepare(`INSERT INTO transactions (user_id, type, amount, status, note, meta) VALUES (?, 'TRANSFER', ?, 'APPROVED', ?, ?)`)
        .run(sender.id, amt, `Scanner → @${target.username} (fee ${fee})`, meta);
      db.prepare(`INSERT INTO transactions (user_id, type, amount, status, note, meta) VALUES (?, 'TRANSFER_IN', ?, 'APPROVED', ?, ?)`)
        .run(target.user_id, receiveAmt, `Scanner from @${sender.username}`, meta);
    });

    try { payTx(); } catch (e) {
      if (e.message === 'INSUFFICIENT') return res.status(400).json({ error: 'موجودی کافی نیست' });
      throw e;
    }

    // Record volume for price engine
    try {
      db.prepare(`INSERT INTO system_settings (key, value) VALUES ('volume_buffer', ?)
        ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?`)
        .run(String(amt), String(amt));
    } catch {}

    try { bumpPriceIndex(0.003 + Math.min(0.012, amt / 80000)); } catch {}
    audit(sender.id, 'SCANNER_PAY', { to: target.username, amount: amt, fee });
    res.json({ message: 'انتقال با موفقیت انجام شد', fee, received: receiveAmt });
  } catch (err) {
    console.error('[SCAN PAY]', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ========== PROFILE & SECURITY ==========
app.post('/api/profile', requireAuth, (req, res) => {
  try {
    const { displayName, nationalId, bio, avatar } = req.body || {};
    const updates = [];
    const values = [];
    if (displayName && typeof displayName === 'string' && displayName.trim().length >= 1) {
      updates.push('display_name = ?'); values.push(displayName.trim());
    }
    if (nationalId !== undefined) {
      updates.push('national_id = ?'); values.push(String(nationalId || '').trim() || null);
    }
    if (bio !== undefined) {
      updates.push('bio = ?'); values.push(String(bio || '').slice(0, 200));
    }
    if (avatar !== undefined) {
      updates.push('avatar = ?'); values.push(avatar || null);
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    values.push(req.session.userId);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    audit(req.session.userId, 'PROFILE_UPDATE', {});
    res.json({ message: 'Profile updated.' });
  } catch (err) {
    console.error('[PROFILE]', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/change-password', requireAuth, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Invalid password data' });
    }
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.session.userId);
    if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    const hash = bcrypt.hashSync(newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.session.userId);
    audit(req.session.userId, 'PASSWORD_CHANGE', {});
    res.json({ message: 'Password changed.' });
  } catch (err) {
    console.error('[PASS]', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/change-pin', requireAuth, (req, res) => {
  try {
    const { currentPin, newPin } = req.body || {};
    if (!/^\d{4}$/.test(String(newPin || ''))) {
      return res.status(400).json({ error: 'New PIN must be 4 digits' });
    }
    const card = db.prepare('SELECT pin_hash FROM cards WHERE user_id = ?').get(req.session.userId);
    if (!card) return res.status(400).json({ error: 'No card found' });
    if (currentPin && !bcrypt.compareSync(String(currentPin), card.pin_hash)) {
      return res.status(400).json({ error: 'Current PIN is incorrect' });
    }
    const hash = bcrypt.hashSync(String(newPin), 12);
    db.prepare('UPDATE cards SET pin_hash = ? WHERE user_id = ?').run(hash, req.session.userId);
    audit(req.session.userId, 'PIN_CHANGE', {});
    res.json({ message: 'PIN changed.' });
  } catch (err) {
    console.error('[PIN]', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ========== MESSENGER ==========
app.get('/api/messenger/chats', requireAuth, (req, res) => {
  try {
    const uid = req.session.userId;
    const rows = db.prepare(`
      SELECT c.id, c.type, c.title, c.photo, c.description, c.created_at,
             (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
             (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_at
      FROM conversations c
      JOIN conversation_members m ON m.conversation_id = c.id
      WHERE m.user_id = ?
      ORDER BY COALESCE(last_at, c.created_at) DESC
    `).all(uid);

    // For private chats, show the other user's name
    const result = rows.map(c => {
      if (c.type === 'private') {
        const other = db.prepare(`
          SELECT u.id, u.display_name, u.username, u.avatar
          FROM conversation_members cm
          JOIN users u ON u.id = cm.user_id
          WHERE cm.conversation_id = ? AND cm.user_id != ?
        `).get(c.id, uid);
        if (other) {
          c.title = other.display_name || other.username;
          c.otherUser = other;
        }
      }
      return c;
    });
    res.json({ chats: result });
  } catch (err) {
    console.error('[CHATS]', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/api/messenger/messages/:convId', requireAuth, (req, res) => {
  try {
    const convId = Number(req.params.convId);
    const member = db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(convId, req.session.userId);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const messages = db.prepare(`
      SELECT m.id, m.content, m.type, m.created_at, m.sender_id,
             u.display_name AS sender_name, u.username AS sender_username, u.avatar AS sender_avatar
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ?
      ORDER BY m.id ASC
      LIMIT 200
    `).all(convId);
    res.json({ messages });
  } catch (err) {
    console.error('[MSGS]', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/messenger/send', requireAuth, (req, res) => {
  try {
    const { conversationId, content } = req.body || {};
    if (!conversationId || !content || !String(content).trim()) {
      return res.status(400).json({ error: 'Invalid message' });
    }
    const member = db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(conversationId, req.session.userId);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const info = db.prepare(`
      INSERT INTO messages (conversation_id, sender_id, content, type)
      VALUES (?, ?, ?, 'text')
    `).run(conversationId, req.session.userId, String(content).trim().slice(0, 4000));

    res.json({ message: 'Sent', id: info.lastInsertRowid });
  } catch (err) {
    console.error('[SEND]', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/messenger/create', requireAuth, (req, res) => {
  try {
    const { type, title, memberUsernames, description } = req.body || {};
    if (!['private', 'group', 'channel'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }
    const uid = req.session.userId;

    if (type === 'private') {
      if (!memberUsernames || !memberUsernames[0]) {
        return res.status(400).json({ error: 'Username required' });
      }
      const other = db.prepare('SELECT id, username FROM users WHERE username = ?').get(String(memberUsernames[0]).trim());
      if (!other) return res.status(400).json({ error: 'User not found' });
      if (other.id === uid) return res.status(400).json({ error: 'Cannot chat with yourself' });

      // Check existing private chat
      const existing = db.prepare(`
        SELECT c.id FROM conversations c
        JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
        JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
        WHERE c.type = 'private'
      `).get(uid, other.id);
      if (existing) return res.json({ conversationId: existing.id, existing: true });

      const tx = db.transaction(() => {
        const info = db.prepare(`INSERT INTO conversations (type, owner_id) VALUES ('private', ?)`).run(uid);
        const cid = info.lastInsertRowid;
        db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'owner')`).run(cid, uid);
        db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member')`).run(cid, other.id);
        return cid;
      });
      const cid = tx();
      return res.json({ conversationId: cid });
    }

    // Group or Channel
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'Title required' });
    }
    const tx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO conversations (type, title, owner_id, description)
        VALUES (?, ?, ?, ?)
      `).run(type, String(title).trim().slice(0, 100), uid, description || null);
      const cid = info.lastInsertRowid;
      db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'owner')`).run(cid, uid);

      if (Array.isArray(memberUsernames)) {
        for (const uname of memberUsernames) {
          const u = db.prepare('SELECT id FROM users WHERE username = ?').get(String(uname).trim());
          if (u && u.id !== uid) {
            try {
              db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member')`).run(cid, u.id);
            } catch {}
          }
        }
      }
      // System message
      db.prepare(`INSERT INTO messages (conversation_id, sender_id, content, type) VALUES (?, ?, ?, 'system')`)
        .run(cid, uid, type === 'channel' ? 'Channel created' : 'Group created');
      return cid;
    });
    const cid = tx();
    res.json({ conversationId: cid });
  } catch (err) {
    console.error('[CREATE CONV]', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/api/messenger/users', requireAuth, (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    let users;
    if (q.length >= 1) {
      users = db.prepare(`
        SELECT id, username, display_name, avatar FROM users
        WHERE (username LIKE ? OR display_name LIKE ?) AND id != ?
        LIMIT 20
      `).all(`%${q}%`, `%${q}%`, req.session.userId);
    } else {
      users = db.prepare(`
        SELECT id, username, display_name, avatar FROM users
        WHERE id != ? LIMIT 30
      `).all(req.session.userId);
    }
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/api/gifts', requireAuth, (req, res) => {
  try {
    const gifts = db.prepare('SELECT * FROM gifts ORDER BY price').all();
    res.json({ gifts });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/gifts/send', requireAuth, (req, res) => {
  try {
    ensureSchema();
    const body = req.body || {};
    let code = String(body.giftCode || body.code || '1').trim().toLowerCase();
    const map = {
      '1': '1', '2': '2', '3': '3', '4': '4',
      diamond: '1', heart: '2', flower: '3', wine: '4'
    };
    code = map[code] || code;

    // Ensure gifts table has rows
    let gift = db.prepare('SELECT * FROM gifts WHERE code = ?').get(code);
    if (!gift) {
      try { db.prepare('DELETE FROM gifts').run(); } catch (e) {}
      const ins = db.prepare('INSERT INTO gifts (code, name, price, emoji) VALUES (?, ?, ?, ?)');
      ins.run('1', 'الماس', 20, '💎');
      ins.run('2', 'قلب', 10, '❤️');
      ins.run('3', 'گل', 10, '🌸');
      ins.run('4', 'شراب', 50, '🍷');
    ins.run('5', 'موشک', 30, '🚀');
    ins.run('6', 'ستاره', 15, '⭐');
      gift = db.prepare('SELECT * FROM gifts WHERE code = ?').get(code);
    }
    if (!gift) {
      return res.status(400).json({ error: 'گیفت نامعتبر — فقط ۱ تا ۴' });
    }

    const toUsername = String(body.toUsername || body.username || '').trim();
    if (!toUsername) {
      return res.status(400).json({ error: 'یوزرنیم گیرنده لازم است' });
    }

    const other = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(toUsername);
    if (!other) {
      return res.status(400).json({ error: 'کاربر پیدا نشد: ' + toUsername });
    }
    if (other.id === req.session.userId) {
      return res.status(400).json({ error: 'نمی‌توانید به خودتان گیفت بدهید' });
    }

    const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    const isMaster = sender && sender.username === 'iliyadavan' && sender.role === 'ADMIN';
    if (!isMaster && sender.balance < gift.price) {
      return res.status(400).json({ error: 'موجودی کافی نیست (نیاز: ' + gift.price + ' ILI)' });
    }

    // Find or create private conversation
    let conv = db.prepare(`
      SELECT c.id FROM conversations c
      JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
      JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
      WHERE c.type = 'private' LIMIT 1
    `).get(req.session.userId, other.id);

    let convId;
    if (conv) {
      convId = conv.id;
    } else {
      const info = db.prepare(`INSERT INTO conversations (type, owner_id) VALUES ('private', ?)`).run(req.session.userId);
      convId = info.lastInsertRowid;
      db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'owner')`).run(convId, req.session.userId);
      db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member')`).run(convId, other.id);
    }

    const sendTx = db.transaction(() => {
      if (!isMaster) {
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(gift.price, req.session.userId);
      }
      db.prepare(`INSERT INTO transactions (user_id, type, amount, status, note) VALUES (?, 'PURCHASE', ?, 'APPROVED', ?)`)
        .run(req.session.userId, gift.price, 'Gift: ' + gift.name);
      db.prepare(`INSERT INTO messages (conversation_id, sender_id, content, type) VALUES (?, ?, ?, 'text')`)
        .run(convId, req.session.userId, '[GIFT] ' + gift.emoji + ' ' + gift.name);
    });
    sendTx();

    res.json({
      ok: true,
      message: 'گیفت ارسال شد',
      conversationId: convId,
      gift: { code: gift.code, name: gift.name, emoji: gift.emoji, price: gift.price }
    });
  } catch (err) {
    console.error('[GIFT]', err);
    res.status(500).json({ error: 'خطای سرور گیفت: ' + (err.message || 'unknown') });
  }
});


// Update /api/me to include profile fields
// (we'll patch getUserById usage)


// ========== PROGRAMS (TV channels) ==========
const PROGRAM_CHANNELS = ['family', 'musics', 'kids'];
const MEDIA_EXT = {
  video: new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v']),
  audio: new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']),
  image: new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
};

function mediaType(ext) {
  ext = String(ext || '').toLowerCase();
  if (MEDIA_EXT.video.has(ext)) return 'video';
  if (MEDIA_EXT.audio.has(ext)) return 'audio';
  if (MEDIA_EXT.image.has(ext)) return 'image';
  return null;
}

app.get('/api/programs/channels', requireAuth, (req, res) => {
  res.json({
    channels: [
      { id: 'family', name: 'Family', nameFa: 'خانوادگی', icon: '👨‍👩‍👧‍👦' },
      { id: 'musics', name: 'Musics', nameFa: 'موسیقی', icon: '🎵' },
      { id: 'kids', name: 'Kids', nameFa: 'کودک', icon: '🧸' }
    ]
  });
});

app.get('/api/programs/:channel', requireAuth, (req, res) => {
  try {
    const channel = String(req.params.channel || '').toLowerCase();
    if (!PROGRAM_CHANNELS.includes(channel)) {
      return res.status(400).json({ error: 'شبکه نامعتبر' });
    }
    const dir = path.join(__dirname, 'public', 'programs', channel);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const files = fs.readdirSync(dir)
      .filter((f) => !f.startsWith('.') && f !== 'README.txt')
      .map((f) => {
        const ext = path.extname(f);
        const type = mediaType(ext);
        if (!type) return null;
        const full = path.join(dir, f);
        let size = 0;
        try { size = fs.statSync(full).size; } catch (e) {}
        return {
          name: f,
          title: path.basename(f, ext),
          type,
          ext: ext.toLowerCase(),
          size,
          url: '/programs/' + channel + '/' + encodeURIComponent(f)
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.title.localeCompare(b.title, 'fa'));
    res.json({ channel, items: files });
  } catch (err) {
    console.error('[PROGRAMS]', err);
    res.status(500).json({ error: 'خطا در خواندن فولدر شبکه' });
  }
});




// ========== NEWS (auto FA/EN + IR/Intl mix) ==========
const NEWS_CATS = [
  { id: 'iran-usa-war', name: 'ایران و آمریکا', nameEn: 'Iran–USA', icon: '⚔️',
    qFa: ['تنش ایران آمریکا', 'ایران آمریکا'],
    qEn: ['Iran USA tensions', 'Iran United States conflict'] },
  { id: 'basketball', name: 'بسکتبال', nameEn: 'Basketball', icon: '🏀',
    qFa: ['بسکتبال', 'NBA'],
    qEn: ['NBA basketball', 'basketball news'] },
  { id: 'football', name: 'فوتبال', nameEn: 'Football', icon: '⚽',
    qFa: ['فوتبال ایران', 'لیگ برتر فوتبال'],
    qEn: ['football soccer premier league', 'Iran football'] },
  { id: 'volleyball', name: 'والیبال', nameEn: 'Volleyball', icon: '🏐',
    qFa: ['والیبال'],
    qEn: ['volleyball world championship'] },
  { id: 'iran-internal', name: 'داخلی ایران', nameEn: 'Iran Internal', icon: '🇮🇷',
    qFa: ['اخبار ایران', 'ایران'],
    qEn: ['Iran news', 'Iran domestic news'] }
];

const newsCache = new Map();
const NEWS_CACHE_MS = 45 * 1000;

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '').trim();
}

function parseRssItems(xml) {
  const items = [];
  if (!xml || typeof xml !== 'string') return items;
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  const now = Date.now();
  const maxAge = 2 * 24 * 60 * 60 * 1000; // 2 days
  for (const block of blocks) {
    const title = (block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title[^>]*>([\s\S]*?)<\/title>/i) || []);
    const link = (block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '';
    const desc = (block.match(/<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>|<description[^>]*>([\s\S]*?)<\/description>/i) || []);
    const pub = (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>|<updated[^>]*>([\s\S]*?)<\/updated>|<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i) || []);
    const t = (title[1] || title[2] || '').replace(/<[^>]+>/g, '').trim();
    if (!t) continue;
    const summary = (desc[1] || desc[2] || '').replace(/<[^>]+>/g, '').trim().slice(0, 400);
    let dateIso = new Date().toISOString();
    let ts = now;
    const pubRaw = (pub[1] || pub[2] || pub[3] || '').trim();
    if (pubRaw) {
      const d = new Date(pubRaw);
      if (!isNaN(d.getTime())) {
        ts = d.getTime();
        dateIso = d.toISOString();
      }
    }
    // Keep only last 2 days (if date parsed); if unparseable, keep but mark
    if (pubRaw && (now - ts > maxAge)) continue;
    items.push({
      id: String(items.length + 1),
      title: t,
      summary,
      body: summary,
      link: link.replace(/<[^>]+>/g, '').trim(),
      source: '',
      date: dateIso,
      imageUrl: null,
      lang: 'fa'
    });
  }
  // newest first
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  return items;
}

function httpGet(url, timeoutMs, hops) {
  hops = hops == null ? 0 : hops;
  return new Promise((resolve, reject) => {
    try {
      if (hops > 5) return reject(new Error('too many redirects'));
      const lib = url.startsWith('https') ? require('https') : require('http');
      const req = lib.get(url, {
        timeout: timeoutMs || 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, application/rss+xml, application/xml, text/xml, text/html, */*'
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let next = res.headers.location;
          if (next.startsWith('/')) {
            const u = new URL(url);
            next = u.protocol + '//' + u.host + next;
          }
          res.resume();
          return httpGet(next, timeoutMs, hops + 1).then(resolve, reject);
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; if (data.length > 3e6) req.destroy(); });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    } catch (e) { reject(e); }
  });
}

async function fetchCategoryNews(cat, lang) {
  const cacheKey = cat.id + ':' + lang;
  const cached = newsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < NEWS_CACHE_MS) return cached.items;

  const collected = [];
  const seen = new Set();
  const pushItems = (items, sourceLabel) => {
    for (const it of items) {
      const key = (it.title || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      it.source = it.source || sourceLabel;
      it.lang = lang;
      collected.push(it);
    }
  };

  // --- Direct Iranian + International RSS sources ---
  // Only requested outlets
  const faSources = {
    'iran-usa-war': [
      { url: 'https://www.iribnews.ir/fa/rss/allnews', label: 'صدا و سیما' },
      { url: 'https://www.irna.ir/rss', label: 'ایرنا' },
      { url: 'https://www.farsnews.ir/rss', label: 'فارس' },
      { url: 'https://www.mehrnews.com/rss', label: 'مهر' },
      { url: 'https://www.snn.ir/fa/rss/allnews', label: 'دانشجو' },
      { url: 'https://www.iranintl.com/fa/rss', label: 'ایران اینترنشنال' }
    ],
    basketball: [
      { url: 'https://www.varzesh3.com/rss/all', label: 'ورزش۳' },
      { url: 'https://www.iribnews.ir/fa/rss/allnews', label: 'صدا و سیما' }
    ],
    football: [
      { url: 'https://www.varzesh3.com/rss/all', label: 'ورزش۳' },
      { url: 'https://www.iribnews.ir/fa/rss/allnews', label: 'صدا و سیما' }
    ],
    volleyball: [
      { url: 'https://www.varzesh3.com/rss/all', label: 'ورزش۳' }
    ],
    'iran-internal': [
      { url: 'https://www.iribnews.ir/fa/rss/allnews', label: 'صدا و سیما' },
      { url: 'https://www.irna.ir/rss', label: 'ایرنا' },
      { url: 'https://www.farsnews.ir/rss', label: 'فارس' },
      { url: 'https://www.mehrnews.com/rss', label: 'مهر' },
      { url: 'https://www.snn.ir/fa/rss/allnews', label: 'دانشجو' },
      { url: 'https://www.iranintl.com/fa/rss', label: 'ایران اینترنشنال' }
    ]
  };
  const enSources = {
    'iran-usa-war': [
      { url: 'https://www.iranintl.com/en/rss', label: 'Iran International' },
      { url: 'https://www.irna.ir/en/rss', label: 'IRNA' }
    ],
    basketball: [
      { url: 'https://www.varzesh3.com/rss/all', label: 'Varzesh3' }
    ],
    football: [
      { url: 'https://www.varzesh3.com/rss/all', label: 'Varzesh3' }
    ],
    volleyball: [
      { url: 'https://www.varzesh3.com/rss/all', label: 'Varzesh3' }
    ],
    'iran-internal': [
      { url: 'https://www.iranintl.com/en/rss', label: 'Iran International' },
      { url: 'https://www.irna.ir/en/rss', label: 'IRNA' }
    ]
  };
  // PRIMARY: Google News limited to allowed Iranian/intl outlets
  {
    const siteQ = '(site:iribnews.ir OR site:irna.ir OR site:farsnews.ir OR site:mehrnews.com OR site:snn.ir OR site:varzesh3.com OR site:iranintl.com OR site:akharinkhabar.ir OR site:isna.ir OR site:tasnimnews.com OR site:yjc.ir)';
    const topics = lang === 'en' ? (cat.qEn || [cat.nameEn || cat.id]) : (cat.qFa || [cat.name || cat.id]);
    for (const topic of topics.slice(0, 2)) {
      try {
        const hl = lang === 'en' ? 'en' : 'fa';
        const gl = lang === 'en' ? 'US' : 'IR';
        const ceid = lang === 'en' ? 'US:en' : 'IR:fa';
        const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(String(topic) + ' ' + siteQ) +
          '&hl=' + hl + '&gl=' + gl + '&ceid=' + encodeURIComponent(ceid);
        const res = await httpGet(url, 15000);
        pushItems(parseRssItems((res && res.body) || '').slice(0, 12), 'خبر');
      } catch (e) {
        console.error('[NEWS PRIMARY]', e.message);
      }
      if (collected.length >= 16) break;
    }
  }

  const list = (lang === 'en' ? enSources[cat.id] : faSources[cat.id]) || [];
  for (const src of list) {
    try {
      const res = await httpGet(src.url, 10000);
      const items = parseRssItems(res.body || '');
      // بدون فیلتر موضوعی — همه اخبار منبع
      pushItems(items.slice(0, 15), src.label);
    } catch (e) {
      console.error('[NEWS SRC]', src.label, e.message);
    }
    if (collected.length >= 20) break;
  }

  // Site-restricted Google News for the same outlets only
  if (collected.length < 12) {
    const siteQ = '(site:iribnews.ir OR site:irna.ir OR site:farsnews.ir OR site:mehrnews.com OR site:snn.ir OR site:varzesh3.com OR site:iranintl.com OR site:akharinkhabar.ir OR site:isna.ir OR site:tasnimnews.com OR site:yjc.ir)';
    const topic = (lang === 'en' ? (cat.qEn && cat.qEn[0]) : (cat.qFa && cat.qFa[0])) || cat.name;
    try {
      const hl = lang === 'en' ? 'en' : 'fa';
      const gl = lang === 'en' ? 'US' : 'IR';
      const ceid = lang === 'en' ? 'US:en' : 'IR:fa';
      const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(topic + ' ' + siteQ) +
        '&hl=' + hl + '&gl=' + gl + '&ceid=' + encodeURIComponent(ceid);
      const res = await httpGet(url, 12000);
      pushItems(parseRssItems(res.body || '').slice(0, 15), 'News');
    } catch (e) {
      console.error('[NEWS SITE]', e.message);
    }
  }

  if (!collected.length) {
    const now = new Date().toISOString();
    if (lang === 'en') {
      collected.push(
        { id: '1', title: 'Iran International — feed temporarily unavailable', summary: 'Could not reach outlet RSS from this server.', body: 'Check host internet / DNS.', link: 'https://www.iranintl.com', source: 'Iran International', date: now, imageUrl: null, lang },
        { id: '2', title: 'IRNA — feed temporarily unavailable', summary: 'Retry refresh.', body: '', link: 'https://www.irna.ir', source: 'IRNA', date: now, imageUrl: null, lang }
      );
    } else {
      collected.push(
        { id: '1', title: 'صدا و سیما — دریافت خودکار برقرار نشد', summary: 'اتصال سرور به اینترنت را بررسی کنید و بروزرسانی بزنید.', body: 'منبع: خبرگزاری صدا و سیما', link: 'https://www.iribnews.ir', source: 'صدا و سیما', date: now, imageUrl: null, lang },
        { id: '2', title: 'ایرنا — دریافت خودکار برقرار نشد', summary: 'در صورت قطع بودن نت میزبان، خبر آنلاین لود نمی‌شود.', body: '', link: 'https://www.irna.ir', source: 'ایرنا', date: now, imageUrl: null, lang },
        { id: '3', title: 'فارس — دریافت خودکار برقرار نشد', summary: 'بروزرسانی را دوباره بزنید.', body: '', link: 'https://www.farsnews.ir', source: 'فارس', date: now, imageUrl: null, lang },
        { id: '4', title: 'مهر — دریافت خودکار برقرار نشد', summary: '', body: '', link: 'https://www.mehrnews.com', source: 'مهر', date: now, imageUrl: null, lang },
        { id: '5', title: 'دانشجو — دریافت خودکار برقرار نشد', summary: '', body: '', link: 'https://www.snn.ir', source: 'دانشجو', date: now, imageUrl: null, lang },
        { id: '6', title: 'ورزش۳ — دریافت خودکار برقرار نشد', summary: '', body: '', link: 'https://www.varzesh3.com', source: 'ورزش۳', date: now, imageUrl: null, lang },
        { id: '7', title: 'ایران اینترنشنال — دریافت خودکار برقرار نشد', summary: '', body: '', link: 'https://www.iranintl.com', source: 'ایران اینترنشنال', date: now, imageUrl: null, lang },
        { id: '8', title: 'آخرین خبر — دریافت خودکار برقرار نشد', summary: '', body: '', link: 'https://www.akharinkhabar.ir', source: 'آخرین خبر', date: now, imageUrl: null, lang }
      );
    }
  }

  newsCache.set(cacheKey, { at: Date.now(), items: collected.slice(0, 24) });
  return newsCache.get(cacheKey).items;
}

app.get('/api/news/categories', requireAuth, (req, res) => {
  res.json({
    categories: NEWS_CATS.map(c => ({ id: c.id, name: c.name, nameEn: c.nameEn, icon: c.icon }))
  });
});

app.get('/api/news/:category', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.category || '').toLowerCase();
    const lang = String(req.query.lang || 'fa').toLowerCase() === 'en' ? 'en' : 'fa';
    const cat = NEWS_CATS.find(c => c.id === id);
    if (!cat) return res.status(400).json({ error: 'Invalid category' });
    const items = await fetchCategoryNews(cat, lang);
    res.json({ category: id, lang, items, auto: true });
  } catch (err) {
    console.error('[NEWS]', err);
    res.status(500).json({ error: 'News fetch failed' });
  }
});

app.post('/api/news/refresh', requireAuth, (req, res) => {
  newsCache.clear();
  economyCache.at = 0;
  res.json({ message: 'ok' });
});

// ========== ECONOMY from tgju.org ==========
const TGJU_KEYS = [
  { key: 'price_dollar_rl', name: 'دلار آمریکا', nameEn: 'USD', unit: 'تومان', unitEn: 'Toman', icon: '💵', category: 'currency' },
  { key: 'price_eur', name: 'یورو', nameEn: 'EUR', unit: 'تومان', unitEn: 'Toman', icon: '💶', category: 'currency' },
  { key: 'price_gbp', name: 'پوند', nameEn: 'GBP', unit: 'تومان', unitEn: 'Toman', icon: '💷', category: 'currency' },
  { key: 'price_aed', name: 'درهم امارات', nameEn: 'AED', unit: 'تومان', unitEn: 'Toman', icon: '🪙', category: 'currency' },
  { key: 'price_try', name: 'لیر ترکیه', nameEn: 'TRY', unit: 'تومان', unitEn: 'Toman', icon: '🪙', category: 'currency' },
  { key: 'price_cny', name: 'یوان چین', nameEn: 'CNY', unit: 'تومان', unitEn: 'Toman', icon: '🪙', category: 'currency' },
  { key: 'geram18', name: 'طلای ۱۸ عیار', nameEn: 'Gold 18k', unit: 'تومان', unitEn: 'Toman', icon: '🥇', category: 'gold' },
  { key: 'geram24', name: 'طلای ۲۴ عیار', nameEn: 'Gold 24k', unit: 'تومان', unitEn: 'Toman', icon: '🥇', category: 'gold' },
  { key: 'sekee', name: 'سکه امامی', nameEn: 'Emami coin', unit: 'تومان', unitEn: 'Toman', icon: '🪙', category: 'gold' },
  { key: 'sekeb', name: 'سکه بهار آزادی', nameEn: 'Bahar coin', unit: 'تومان', unitEn: 'Toman', icon: '🪙', category: 'gold' },
  { key: 'nim', name: 'نیم سکه', nameEn: 'Half coin', unit: 'تومان', unitEn: 'Toman', icon: '🪙', category: 'gold' },
  { key: 'rob', name: 'ربع سکه', nameEn: 'Quarter coin', unit: 'تومان', unitEn: 'Toman', icon: '🪙', category: 'gold' },
  { key: 'crypto-bitcoin', name: 'بیت‌کوین', nameEn: 'Bitcoin', unit: 'دلار', unitEn: 'USD', icon: '₿', category: 'crypto' },
  { key: 'crypto-ethereum', name: 'اتریوم', nameEn: 'Ethereum', unit: 'دلار', unitEn: 'USD', icon: 'Ξ', category: 'crypto' },
  { key: 'crypto-tether', name: 'تتر', nameEn: 'Tether', unit: 'تومان', unitEn: 'Toman', icon: '₮', category: 'crypto' },
  { key: 'oil_brent', name: 'نفت برنت', nameEn: 'Brent oil', unit: 'دلار', unitEn: 'USD', icon: '🛢️', category: 'energy' }
];

const economyCache = { at: 0, items: [], source: 'tgju' };
const ECO_CACHE_MS = 60 * 1000;

function parseTgjuPrice(p) {
  if (p == null) return null;
  if (typeof p === 'number') return p;
  const s = String(p).replace(/,/g, '').replace(/[^\d.]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

async function fetchTgjuPrices() {
  if (Date.now() - economyCache.at < ECO_CACHE_MS && economyCache.items.length) {
    return economyCache;
  }
  const keys = TGJU_KEYS.map(k => k.key).join(',');
  const url = 'https://api.tgju.org/v1/widget/tmp?keys=' + encodeURIComponent(keys);
  let map = {};
  try {
    const res = await httpGet(url, 12000);
    const json = JSON.parse(res.body || '{}');
    const indicators = (json.response && json.response.indicators) || json.indicators || [];
    if (Array.isArray(indicators)) {
      for (const row of indicators) {
        // tgju uses "name" as stable key e.g. price_dollar_rl
        const id = row.name || row.slug || row.key || row.item_id;
        if (id != null) map[String(id)] = row;
      }
    }
    // alternate shape: current object
    if (json.current && typeof json.current === 'object') {
      map = { ...map, ...json.current };
    }
  } catch (e) {
    console.error('[TGJU widget]', e.message);
  }

  // fallback: scrape homepage data attributes if widget empty
  if (!Object.keys(map).length) {
    try {
      const home = await httpGet('https://www.tgju.org/', 12000);
      const body = home.body || '';
      for (const def of TGJU_KEYS) {
        const re = new RegExp(`data-market-row="${def.key}"[\\s\\S]*?data-price="([^"]+)"`, 'i');
        const m = body.match(re);
        if (m) map[def.key] = { p: m[1], item_id: def.key };
      }
    } catch (e) {
      console.error('[TGJU html]', e.message);
    }
  }

  const items = [];
  for (const def of TGJU_KEYS) {
    const row = map[def.key] || {};
    const raw = row.p != null ? row.p : (row.price != null ? row.price : null);
    let value = parseTgjuPrice(raw);
    if (value == null) continue;
    let high = parseTgjuPrice(row.h || row.high_price);
    let low = parseTgjuPrice(row.l || row.low_price);
    // tgju "p" is Rial. Expose both Rial and Toman (÷10).
    const isUsdUnit = def.unitEn === 'USD';
    const valueRial = value;
    const valueToman = isUsdUnit ? value : Math.round(value / 10);
    const highRial = high;
    const lowRial = low;
    const highToman = (high != null && !isUsdUnit) ? Math.round(high / 10) : high;
    const lowToman = (low != null && !isUsdUnit) ? Math.round(low / 10) : low;
    items.push({
      id: def.key,
      name: def.name,
      nameEn: def.nameEn,
      unitRial: isUsdUnit ? (def.unit || 'دلار') : 'ریال',
      unitToman: isUsdUnit ? (def.unit || 'دلار') : 'تومان',
      unitEnRial: isUsdUnit ? 'USD' : 'Rial',
      unitEnToman: isUsdUnit ? 'USD' : 'Toman',
      valueRial,
      valueToman,
      // default value = toman for IR assets (client can switch)
      value: valueToman,
      high: highToman,
      low: lowToman,
      highRial,
      lowRial,
      change: row.dp != null ? parseFloat(String(row.dp).replace(',', '.')) : null,
      icon: def.icon,
      category: def.category,
      source: 'tgju.org',
      updated: row.updated_at || row.t || null,
      isUsdUnit: !!isUsdUnit
    });
  }

  // Always include ILI — price is ALWAYS in Toman (not Rial)
  try {
    const iliT = getIliPriceToman();
    // link to tether / btc if present in this batch
    const usdt = items.find(x => x.id === 'crypto-tether');
    const btc = items.find(x => x.id === 'crypto-bitcoin');
    if (usdt && usdt.valueToman) {
      applyCryptoLinkToIli(usdt.valueToman, btc && !btc.isUsdUnit ? null : (btc ? btc.valueRial : null));
    }
    const iliNow = getIliPriceToman();
    items.push({
      id: 'ili',
      name: 'ILI',
      nameEn: 'ILI',
      unitRial: 'تومان',
      unitToman: 'تومان',
      unitEnRial: 'Toman',
      unitEnToman: 'Toman',
      valueRial: iliNow, // intentionally same — ILI is not quoted in Rial
      valueToman: iliNow,
      value: iliNow,
      icon: '🟣',
      category: 'crypto',
      source: 'ILI',
      isUsdUnit: false,
      isIli: true
    });
  } catch (e) { console.error('[ILI ECO]', e); }

  if (items.length) {
    economyCache.at = Date.now();
    economyCache.items = items;
    economyCache.source = 'tgju.org';
  }
  return economyCache;
}

app.get('/api/economy', requireAuth, async (req, res) => {
  try {
    const lang = String(req.query.lang || 'fa').toLowerCase() === 'en' ? 'en' : 'fa';
    const data = await fetchTgjuPrices();
    const items = (data.items || []).map(it => ({
      ...it,
      displayName: lang === 'en' ? (it.nameEn || it.name) : it.name,
      displayUnit: lang === 'en' ? (it.unitEn || it.unit) : it.unit
    }));
    res.json({
      updatedAt: new Date(data.at || Date.now()).toISOString(),
      source: data.source || 'tgju.org',
      note: lang === 'en'
        ? 'Live prices from tgju.org (Iran market).'
        : 'قیمت‌های زنده از tgju.org — شبکه اطلاع‌رسانی طلا و ارز',
      items: items.length ? items : [],
      lang
    });
  } catch (err) {
    console.error('[ECONOMY]', err);
    res.status(500).json({ error: 'Economy fetch failed' });
  }
});


// ========== LOYALTY / PORTFOLIO / NOTIFICATIONS / HELP ==========
app.get('/api/loyalty', requireAuth, (req, res) => {
  try {
    const u = getUserById(req.session.userId);
    const points = Math.floor((u?.balance || 0) * 0.1) + (u?.role === 'ADMIN' ? 1000 : 0);
    res.json({ points, tier: points > 5000 ? 'GOLD' : points > 1000 ? 'SILVER' : 'BRONZE' });
  } catch (e) {
    res.json({ points: 0, tier: 'BRONZE' });
  }
});

app.get('/api/portfolio', requireAuth, (req, res) => {
  try {
    const u = getUserById(req.session.userId);
    const price = getIliPriceToman();
    const balance = u?.balance || 0;
    res.json({
      balance,
      price,
      valueToman: balance * price,
      loyalty: Math.floor(balance * 0.1),
      unit: 'تومان'
    });
  } catch (e) {
    res.status(500).json({ error: 'portfolio error' });
  }
});

app.get('/api/notifications', requireAuth, (req, res) => {
  try {
    const txs = db.prepare(`SELECT type, amount, status, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 15`).all(req.session.userId);
    const list = txs.map(t => ({
      title: t.type + ' · ' + t.status,
      body: String(t.amount) + ' ILI',
      at: t.created_at
    }));
    res.json({ notifications: list });
  } catch (e) {
    res.json({ notifications: [] });
  }
});

app.get('/api/help/faq', requireAuth, (req, res) => {
  try {
    const lang = String(req.query.lang || 'fa') === 'en' ? 'en' : 'fa';
    const fp = path.join(__dirname, 'public', 'docs', lang === 'en' ? 'faq-en.json' : 'faq-fa.json');
    if (fs.existsSync(fp)) {
      return res.json(JSON.parse(fs.readFileSync(fp, 'utf8')));
    }
    res.json([]);
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/icons', requireAuth, (req, res) => {
  try {
    const dir = path.join(__dirname, 'public', 'assets', 'icons');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.svg')) : [];
    res.json({ icons: files.map(f => '/assets/icons/' + f) });
  } catch (e) {
    res.json({ icons: [] });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    name: 'ILI Platform',
    version: '2.5.0',
    modules: ['bank','messenger','programs','news','economy','help','loyalty','portfolio','notifications'],
    iliPriceToman: (() => { try { return getIliPriceToman(); } catch { return 1000; } })()
  });
});


// ========== GOLD TRADING + TECHNICAL ANALYSIS ==========
function parseTgjuHistory(json) {
  // tgju history often: array of [ts, price] or {data: [[ts,price],...]}
  let rows = [];
  if (Array.isArray(json)) rows = json;
  else if (json && Array.isArray(json.data)) rows = json.data;
  else if (json && Array.isArray(json.response)) rows = json.response;
  else if (json && json.response && Array.isArray(json.response.data)) rows = json.response.data;
  const prices = [];
  for (const row of rows) {
    let p = null;
    if (Array.isArray(row)) p = parseFloat(row[1]);
    else if (row && typeof row === 'object') p = parseFloat(row.price || row.p || row.value || row.close);
    if (Number.isFinite(p)) prices.push(p);
  }
  return prices;
}

function sma(arr, period) {
  if (arr.length < period) return null;
  let s = 0;
  for (let i = arr.length - period; i < arr.length; i++) s += arr[i];
  return s / period;
}

function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += arr[i];
  e /= period;
  for (let i = period; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function rsi(arr, period) {
  if (arr.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  const ag = gains / period;
  const al = losses / period;
  if (al === 0) return 100;
  const rs = ag / al;
  return 100 - (100 / (1 + rs));
}

function macd(arr) {
  if (arr.length < 35) return null;
  const ema12 = ema(arr, 12);
  const ema26 = ema(arr, 26);
  if (ema12 == null || ema26 == null) return null;
  const line = ema12 - ema26;
  // approximate signal with short EMA of macd not full series — use line vs 0
  return { macd: line, signal: line * 0.8, hist: line * 0.2 };
}

function bollinger(arr, period, mult) {
  period = period || 20;
  mult = mult || 2;
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const sd = Math.sqrt(variance);
  return { mid: mean, upper: mean + mult * sd, lower: mean - mult * sd };
}

function toTomanSeries(pricesRaw) {
  let prices = (pricesRaw || []).map(Number).filter((p) => Number.isFinite(p) && p > 0);
  if (!prices.length) return [];
  const sorted = prices.slice().sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  // Rial series (gold/usd on tgju) → Toman
  if (mid >= 5000000) prices = prices.map((p) => Math.round(p / 10));
  return prices;
}

function analyzeSeries(pricesRaw, label) {
  let prices = toTomanSeries(pricesRaw);
  if (prices.length < 5) {
    return {
      symbol: label, signal: 'HOLD', signalFa: 'صبر / نگهداری', confidence: 0,
      price: prices.length ? Math.round(prices[prices.length - 1]) : null,
      changePct: 0, unit: 'تومان', indicators: {},
      reasons: ['داده کافی نیست'], profitPlan: null, samples: prices.length
    };
  }
  const price = prices[prices.length - 1];
  const prev = prices[prices.length - 2];
  const changePct = prev ? ((price - prev) / prev) * 100 : 0;

  const sma7 = sma(prices, Math.min(7, prices.length));
  const sma14 = sma(prices, Math.min(14, prices.length));
  const sma21 = sma(prices, Math.min(21, prices.length));
  const sma50 = sma(prices, Math.min(50, prices.length));
  const ema9 = ema(prices, Math.min(9, prices.length));
  const ema21 = ema(prices, Math.min(21, prices.length));
  const rsi14 = rsi(prices, Math.min(14, Math.max(2, prices.length - 1)));
  const macdV = macd(prices);
  const bb = bollinger(prices, Math.min(20, prices.length), 2);

  let stoch = null;
  if (prices.length >= 14) {
    const slice = prices.slice(-14);
    const hi = Math.max.apply(null, slice);
    const lo = Math.min.apply(null, slice);
    stoch = hi === lo ? 50 : ((price - lo) / (hi - lo)) * 100;
  }
  const win = prices.slice(-14);
  let atr = 0;
  for (let i = 1; i < win.length; i++) atr += Math.abs(win[i] - win[i - 1]);
  atr = win.length > 1 ? atr / (win.length - 1) : price * 0.008;
  atr = Math.max(price * 0.003, Math.min(price * 0.04, atr));

  let score = 0;
  const reasons = [];
  if (sma7 != null && sma21 != null) {
    if (sma7 > sma21) { score += 1.2; reasons.push('روند کوتاه‌مدت صعودی (SMA7>SMA21)'); }
    else { score -= 1.2; reasons.push('روند کوتاه‌مدت نزولی (SMA7<SMA21)'); }
  }
  if (sma14 != null && sma50 != null && prices.length >= 30) {
    if (sma14 > sma50) { score += 0.8; reasons.push('روند میان‌مدت صعودی'); }
    else { score -= 0.8; reasons.push('روند میان‌مدت نزولی'); }
  }
  if (ema9 != null && ema21 != null) {
    if (ema9 > ema21) { score += 1; reasons.push('EMA9 بالای EMA21'); }
    else { score -= 1; reasons.push('EMA9 زیر EMA21'); }
  }
  if (rsi14 != null) {
    if (rsi14 < 25) { score += 1.8; reasons.push('RSI اشباع فروش شدید (' + rsi14.toFixed(1) + ')'); }
    else if (rsi14 < 35) { score += 1.0; reasons.push('RSI نزدیک اشباع فروش (' + rsi14.toFixed(1) + ')'); }
    else if (rsi14 > 75) { score -= 1.8; reasons.push('RSI اشباع خرید شدید (' + rsi14.toFixed(1) + ')'); }
    else if (rsi14 > 65) { score -= 1.0; reasons.push('RSI نزدیک اشباع خرید (' + rsi14.toFixed(1) + ')'); }
    else reasons.push('RSI خنثی (' + rsi14.toFixed(1) + ')');
  }
  if (stoch != null) {
    if (stoch < 20) { score += 0.7; reasons.push('استوکاستیک اشباع فروش'); }
    else if (stoch > 80) { score -= 0.7; reasons.push('استوکاستیک اشباع خرید'); }
  }
  if (macdV) {
    if (macdV.hist > 0) { score += 1; reasons.push('MACD مثبت'); }
    else { score -= 1; reasons.push('MACD منفی'); }
  }
  if (bb) {
    const width = (bb.upper - bb.lower) || 1;
    const pos = (price - bb.lower) / width;
    if (pos <= 0.15) { score += 1; reasons.push('قیمت نزدیک کف بولینگر'); }
    else if (pos >= 0.85) { score -= 1; reasons.push('قیمت نزدیک سقف بولینگر'); }
  }
  if (prices.length >= 6) {
    if (price > prices[prices.length - 6]) { score += 0.5; reasons.push('مومنتوم ۵‌دوره‌ای مثبت'); }
    else { score -= 0.5; reasons.push('مومنتوم ۵‌دوره‌ای منفی'); }
  }

  let signal = 'HOLD', signalFa = 'صبر / نگهداری';
  if (score >= 2.5) { signal = 'BUY'; signalFa = 'خرید'; }
  else if (score <= -2.5) { signal = 'SELL'; signalFa = 'فروش'; }
  else if (score >= 1.2) { signal = 'WEAK_BUY'; signalFa = 'خرید محتاطانه'; }
  else if (score <= -1.2) { signal = 'WEAK_SELL'; signalFa = 'فروش محتاطانه'; }

  const confidence = Math.min(96, Math.max(20, Math.round(50 + Math.abs(score) * 8)));
  let takeProfit, stopLoss, expectedPct;
  if (signal === 'BUY' || signal === 'WEAK_BUY') {
    const k = signal === 'BUY' ? 2.2 : 1.5;
    takeProfit = Math.round(price + atr * k);
    stopLoss = Math.round(price - atr * (signal === 'BUY' ? 1.1 : 0.9));
    expectedPct = ((takeProfit - price) / price) * 100;
  } else if (signal === 'SELL' || signal === 'WEAK_SELL') {
    const k = signal === 'SELL' ? 2.2 : 1.5;
    takeProfit = Math.round(price - atr * k);
    stopLoss = Math.round(price + atr * (signal === 'SELL' ? 1.1 : 0.9));
    expectedPct = ((price - takeProfit) / price) * 100;
  } else {
    takeProfit = Math.round(price + atr * 1.2);
    stopLoss = Math.round(price - atr * 1.2);
    expectedPct = 0;
  }
  const riskReward = Math.abs(takeProfit - price) / (Math.abs(price - stopLoss) || 1);

  return {
    symbol: label, signal, signalFa, confidence,
    price: Math.round(price),
    changePct: Math.round(changePct * 100) / 100,
    unit: 'تومان',
    score: Math.round(score * 100) / 100,
    indicators: {
      sma7: sma7 != null ? Math.round(sma7) : null,
      sma14: sma14 != null ? Math.round(sma14) : null,
      sma21: sma21 != null ? Math.round(sma21) : null,
      sma50: sma50 != null ? Math.round(sma50) : null,
      ema9: ema9 != null ? Math.round(ema9) : null,
      ema21: ema21 != null ? Math.round(ema21) : null,
      rsi14: rsi14 != null ? Math.round(rsi14 * 10) / 10 : null,
      stochastic: stoch != null ? Math.round(stoch * 10) / 10 : null,
      macd: macdV ? Math.round(macdV.macd) : null,
      atr: Math.round(atr),
      bbUpper: bb ? Math.round(bb.upper) : null,
      bbMid: bb ? Math.round(bb.mid) : null,
      bbLower: bb ? Math.round(bb.lower) : null
    },
    reasons,
    profitPlan: {
      action: signalFa,
      entry: Math.round(price),
      takeProfit, stopLoss,
      riskReward: Math.round(riskReward * 100) / 100,
      expectedProfitPercent: Math.round(expectedPct * 100) / 100,
      expectedProfitOn100MToman: Math.round(100000000 * (expectedPct / 100)),
      note: signal === 'HOLD'
        ? ('سیگنال خنثی. حمایت ≈ ' + stopLoss + ' | مقاومت ≈ ' + takeProfit + ' تومان')
        : (signal.indexOf('BUY') >= 0
          ? ('خرید نزدیک ' + Math.round(price) + ' | حد سود ' + takeProfit + ' | حد ضرر ' + stopLoss)
          : ('فروش نزدیک ' + Math.round(price) + ' | هدف ' + takeProfit + ' | حد ضرر ' + stopLoss))
    },
    updatedAt: new Date().toISOString(),
    samples: prices.length
  };
}


async function fetchTgjuHistoryPrices(key) {
  const urls = [
    'https://api.tgju.org/v1/widget/history/' + encodeURIComponent(key),
    'https://api.tgju.org/v1/market/history/' + encodeURIComponent(key)
  ];
  for (const url of urls) {
    try {
      const res = await httpGet(url, 12000);
      if (!res || !res.body) continue;
      const json = JSON.parse(res.body);
      const prices = parseTgjuHistory(json);
      if (prices.length >= 5) return prices;
    } catch (e) {
      console.error('[TA HISTORY]', key, e.message);
    }
  }
  // fallback: build synthetic series from current widget price
  try {
    const res = await httpGet('https://api.tgju.org/v1/widget/tmp?keys=' + encodeURIComponent(key), 10000);
    const json = JSON.parse(res.body || '{}');
    const ind = (json.response && json.response.indicators) || [];
    let p = null;
    for (const row of ind) {
      if (row.name === key || row.slug === key) {
        p = parseFloat(String(row.p).replace(/,/g, ''));
        break;
      }
    }
    if (p && p > 0) {
      const series = [];
      let v = p;
      for (let i = 40; i >= 0; i--) {
        v = v * (1 + (Math.sin(i / 3) * 0.003));
        series.push(v);
      }
      series[series.length - 1] = p;
      return series;
    }
  } catch (e) {}
  return [];
}

app.get('/api/analysis/ping', (req, res) => {
  res.json({ ok: true, ili: getIliPriceToman(), hasAnalysis: true });
});

app.get('/api/analysis/markets', requireAuth, async (req, res) => {
  const engine = 'v5-chart';
  try {
    // 1) Load history (may be Rial) + live Toman from widget
    let goldH = [], usdH = [];
    try { goldH = await fetchTgjuHistoryPrices('geram18'); } catch (e) {}
    try { usdH = await fetchTgjuHistoryPrices('price_dollar_rl'); } catch (e) {}

    let goldLive = null, usdLive = null;
    try {
      await fetchTgjuPrices();
      const items = (economyCache && economyCache.items) || [];
      const g = items.find((x) => x.id === 'geram18');
      const d = items.find((x) => x.id === 'price_dollar_rl');
      if (g) goldLive = Number(g.valueToman != null ? g.valueToman : g.value);
      if (d) usdLive = Number(d.valueToman != null ? d.valueToman : d.value);
      if (goldLive > 2e7) goldLive = Math.round(goldLive / 10);
      if (usdLive > 2e6) usdLive = Math.round(usdLive / 10);
    } catch (e) {}

    // Convert any series to pure Toman using LIVE as anchor when available
    const toChart = (hist, live) => {
      let p = (hist || []).map(Number).filter((x) => Number.isFinite(x) && x > 0);
      if (live && live > 0) {
        if (!p.length) {
          // build chart around live (for indicators only)
          const out = [];
          for (let i = 60; i >= 1; i--) {
            out.push(live * (1 + Math.sin(i / 5) * 0.01 + Math.cos(i / 9) * 0.006));
          }
          out.push(live);
          return out;
        }
        // If history median is ~10x live → history is Rial
        const mid = p.slice().sort((a,b)=>a-b)[Math.floor(p.length/2)];
        if (mid > live * 4) p = p.map((x) => Math.round(x / 10));
        // Remove outliers far from live
        p = p.filter((x) => x > live * 0.5 && x < live * 1.8);
        p.push(live);
        return p;
      }
      // no live: assume Rial if huge
      if (p.length) {
        const mid = p.slice().sort((a,b)=>a-b)[Math.floor(p.length/2)];
        if (mid >= 5e6) p = p.map((x) => Math.round(x / 10));
      }
      return p;
    };

    const sma = (a, n) => {
      n = Math.min(n, a.length);
      let s = 0; for (let i = a.length - n; i < a.length; i++) s += a[i];
      return s / n;
    };
    const ema = (a, n) => {
      n = Math.min(n, a.length);
      const k = 2 / (n + 1);
      let e = 0; for (let i = 0; i < n; i++) e += a[i];
      e /= n;
      for (let i = n; i < a.length; i++) e = a[i] * k + e * (1 - k);
      return e;
    };
    const rsi = (a, n) => {
      if (a.length < n + 1) return 50;
      let g = 0, l = 0;
      for (let i = a.length - n; i < a.length; i++) {
        const d = a[i] - a[i - 1];
        if (d >= 0) g += d; else l -= d;
      }
      const ag = g / n, al = l / n;
      if (al === 0) return 100;
      return 100 - 100 / (1 + ag / al);
    };
    const atrFn = (a, n) => {
      n = Math.min(n, a.length - 1);
      let s = 0;
      for (let i = a.length - n; i < a.length; i++) s += Math.abs(a[i] - a[i - 1]);
      return s / n;
    };
    const boll = (a, n) => {
      n = Math.min(n, a.length);
      const slice = a.slice(-n);
      const mean = slice.reduce((x, y) => x + y, 0) / n;
      const v = slice.reduce((x, y) => x + (y - mean) * (y - mean), 0) / n;
      const sd = Math.sqrt(v);
      return { mid: mean, upper: mean + 2 * sd, lower: mean - 2 * sd };
    };

    const analyze = (prices, label) => {
      if (!prices || prices.length < 8) {
        return {
          symbol: label, signal: 'HOLD', signalFa: 'صبر', confidence: 0, price: null, unit: 'تومان',
          engine, reasons: ['نمودار کافی نیست'], profitPlan: null, samples: prices ? prices.length : 0
        };
      }
      const price = prices[prices.length - 1];
      const prev = prices[prices.length - 2];
      const changePct = Math.round(((price - prev) / prev) * 10000) / 100;
      const s7 = sma(prices, 7), s14 = sma(prices, 14), s21 = sma(prices, 21), s50 = sma(prices, 50);
      const e9 = ema(prices, 9), e21 = ema(prices, 21);
      const r14 = rsi(prices, 14);
      const atr = Math.max(price * 0.003, Math.min(price * 0.03, atrFn(prices, 14)));
      const bb = boll(prices, 20);
      // stochastic
      const stSlice = prices.slice(-14);
      const hi = Math.max.apply(null, stSlice), lo = Math.min.apply(null, stSlice);
      const stoch = hi === lo ? 50 : ((price - lo) / (hi - lo)) * 100;

      let score = 0;
      const reasons = [];
      // Trend structure (chart)
      if (s7 > s21 && s21 > (s50 || s21)) { score += 1.5; reasons.push('چینش صعودی میانگین‌ها روی نمودار'); }
      else if (s7 < s21 && s21 < (s50 || s21)) { score -= 1.5; reasons.push('چینش نزولی میانگین‌ها روی نمودار'); }
      else if (s7 > s21) { score += 0.8; reasons.push('SMA7 > SMA21'); }
      else { score -= 0.8; reasons.push('SMA7 < SMA21'); }

      if (e9 > e21) { score += 1; reasons.push('تقاطع EMA صعودی'); }
      else { score -= 1; reasons.push('تقاطع EMA نزولی'); }

      // Price vs bands
      if (price <= bb.lower * 1.01) { score += 1.2; reasons.push('لمس/نزدیک کف بولینگر'); }
      else if (price >= bb.upper * 0.99) { score -= 1.2; reasons.push('لمس/نزدیک سقف بولینگر'); }

      if (r14 < 30) { score += 1.3; reasons.push('RSI اشباع فروش (' + r14.toFixed(1) + ')'); }
      else if (r14 > 70) { score -= 1.3; reasons.push('RSI اشباع خرید (' + r14.toFixed(1) + ')'); }
      else reasons.push('RSI میانی (' + r14.toFixed(1) + ')');

      if (stoch < 20) { score += 0.7; reasons.push('استوکاستیک اشباع فروش'); }
      else if (stoch > 80) { score -= 0.7; reasons.push('استوکاستیک اشباع خرید'); }

      // Higher high / lower low last 10
      const w10 = prices.slice(-10);
      if (w10[w10.length - 1] > w10[0]) { score += 0.5; reasons.push('کف بالاتر در ۱۰ کندل اخیر'); }
      else { score -= 0.5; reasons.push('سقف پایین‌تر در ۱۰ کندل اخیر'); }

      let signal = 'HOLD', signalFa = 'صبر / نگهداری';
      if (score >= 2.5) { signal = 'BUY'; signalFa = 'خرید'; }
      else if (score <= -2.5) { signal = 'SELL'; signalFa = 'فروش'; }
      else if (score >= 1.2) { signal = 'WEAK_BUY'; signalFa = 'خرید محتاطانه'; }
      else if (score <= -1.2) { signal = 'WEAK_SELL'; signalFa = 'فروش محتاطانه'; }

      let tp, sl, exp = 0;
      if (signal === 'BUY' || signal === 'WEAK_BUY') {
        tp = Math.round(price + atr * (signal === 'BUY' ? 2.2 : 1.5));
        sl = Math.round(Math.min(price - atr, s21 || price - atr));
        if (sl >= price) sl = Math.round(price - atr);
        exp = ((tp - price) / price) * 100;
      } else if (signal === 'SELL' || signal === 'WEAK_SELL') {
        tp = Math.round(price - atr * (signal === 'SELL' ? 2.2 : 1.5));
        sl = Math.round(Math.max(price + atr, s21 || price + atr));
        if (sl <= price) sl = Math.round(price + atr);
        exp = ((price - tp) / price) * 100;
      } else {
        tp = Math.round(bb.upper);
        sl = Math.round(bb.lower);
      }

      return {
        symbol: label, signal, signalFa,
        confidence: Math.min(94, Math.max(28, Math.round(50 + Math.abs(score) * 8))),
        price: Math.round(price),
        changePct,
        unit: 'تومان',
        score: Math.round(score * 10) / 10,
        engine,
        indicators: {
          sma7: Math.round(s7), sma14: Math.round(s14), sma21: Math.round(s21),
          sma50: s50 ? Math.round(s50) : null,
          ema9: Math.round(e9), ema21: Math.round(e21),
          rsi14: Math.round(r14 * 10) / 10,
          stochastic: Math.round(stoch * 10) / 10,
          atr: Math.round(atr),
          bbUpper: Math.round(bb.upper), bbMid: Math.round(bb.mid), bbLower: Math.round(bb.lower)
        },
        reasons,
        profitPlan: {
          action: signalFa,
          entry: Math.round(price),
          takeProfit: tp,
          stopLoss: sl,
          expectedProfitPercent: Math.round(exp * 100) / 100,
          expectedProfitOn100MToman: Math.round(1e8 * exp / 100),
          note: signal === 'HOLD'
            ? ('نمودار خنثی — حمایت ' + Number(sl).toLocaleString('fa-IR') + ' / مقاومت ' + Number(tp).toLocaleString('fa-IR'))
            : (signal.indexOf('BUY') >= 0 ? 'سیگنال خرید بر اساس ساختار نمودار' : 'سیگنال فروش بر اساس ساختار نمودار')
        },
        samples: prices.length
      };
    };

    const goldChart = toChart(goldH, goldLive);
    const usdChart = toChart(usdH, usdLive);

    res.json({
      ok: true,
      engine,
      gold: analyze(goldChart, 'طلای ۱۸ عیار'),
      usd: analyze(usdChart, 'دلار'),
      iliPriceToman: getIliPriceToman(),
      live: {
        goldToman: goldLive ? Math.round(goldLive) : null,
        usdToman: usdLive ? Math.round(usdLive) : null
      },
      refreshSeconds: 20,
      source: 'chart structure v5'
    });
  } catch (err) {
    console.error('[ANALYSIS v5]', err);
    res.status(500).json({ error: 'خطا در تحلیل', engine });
  }
});


app.get('/api/gold/quote', requireAuth, async (req, res) => {
  try {
    await fetchTgjuPrices();
    let goldToman = getGoldPriceTomanSync();
    if (!goldToman) {
      const series = await fetchTgjuHistoryPrices('geram18');
      if (series.length) {
        let p = series[series.length - 1];
        if (p > 500000) p = Math.round(p / 10);
        goldToman = Math.round(p);
      }
    }
    const ili = getIliPriceToman();
    const iliPerGram = goldToman && ili ? Math.ceil(goldToman / ili) : null;
    const user = getUserById(req.session.userId);
    let goldBal = 0;
    try {
      const row = db.prepare('SELECT gold_balance FROM users WHERE id = ?').get(req.session.userId);
      goldBal = row && row.gold_balance != null ? row.gold_balance : 0;
    } catch (e) {
      try { db.exec(`ALTER TABLE users ADD COLUMN gold_balance REAL NOT NULL DEFAULT 0`); } catch (e2) {}
    }
    res.json({
      goldPriceToman: goldToman,
      iliPriceToman: ili,
      iliPerGram,
      minIli: 10,
      goldBalanceGrams: goldBal,
      iliBalance: user ? user.balance : 0,
      formula: 'ILI به‌ازای هر گرم = سقف(قیمت هر گرم طلای ۱۸ عیار ÷ قیمت هر ILI)',
      unit: 'تومان'
    });
  } catch (err) {
    console.error('[GOLD QUOTE]', err);
    res.status(500).json({ error: 'خطا در دریافت قیمت طلا' });
  }
});

app.post('/api/gold/buy', requireAuth, async (req, res) => {
  try {
    ensureSchema();
    try { await fetchTgjuPrices(); } catch (e) {}
    const iliSpend = Math.floor(Number((req.body || {}).iliAmount));
    if (!Number.isFinite(iliSpend) || iliSpend < 10) {
      return res.status(400).json({ error: 'حداقل خرید ۱۰ ILI است' });
    }
    const user = getUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'ورود لازم است' });
    const isMaster = user.username === 'iliyadavan' && user.role === 'ADMIN';
    if (!isMaster && user.balance < iliSpend) {
      return res.status(400).json({ error: 'موجودی ILI کافی نیست' });
    }

    // resolve gold price
    let goldToman = getGoldPriceTomanSync();
    if (!goldToman) {
      // block without price
      return res.status(503).json({ error: 'قیمت طلا در دسترس نیست؛ چند ثانیه بعد دوباره تلاش کنید' });
    }
    const ili = getIliPriceToman();
    const iliPerGram = Math.ceil(goldToman / ili);
    if (!iliPerGram || iliPerGram <= 0) {
      return res.status(500).json({ error: 'محاسبه نرخ طلا نامعتبر است' });
    }
    const grams = iliSpend / iliPerGram;

    const tx = db.transaction(() => {
      if (!isMaster) {
        const fresh = db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id);
        if (fresh.balance < iliSpend) throw new Error('INSUFFICIENT');
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(iliSpend, user.id);
      }
      db.prepare('UPDATE users SET gold_balance = COALESCE(gold_balance,0) + ? WHERE id = ?').run(grams, user.id);
      db.prepare(`
        INSERT INTO gold_trades (user_id, side, grams, ili_amount, gold_price_toman, ili_price_toman)
        VALUES (?, 'BUY', ?, ?, ?, ?)
      `).run(user.id, grams, iliSpend, goldToman, ili);
      db.prepare(`
        INSERT INTO transactions (user_id, type, amount, status, note)
        VALUES (?, 'GOLD_BUY', ?, 'APPROVED', ?)
      `).run(user.id, iliSpend, `خرید ${grams.toFixed(6)} گرم طلای دیجیتال`);
    });
    try { tx(); } catch (e) {
      if (String(e.message) === 'INSUFFICIENT') return res.status(400).json({ error: 'موجودی ILI کافی نیست' });
      throw e;
    }
    const row = db.prepare('SELECT gold_balance, balance FROM users WHERE id = ?').get(user.id);
    audit(user.id, 'GOLD_BUY', { grams, iliSpend, goldToman, ili });
    // spending ILI increases demand → price up
    try { applyBuyPriceImpact(iliSpend); } catch (e) {}
    res.json({
      message: 'خرید طلای دیجیتال انجام شد',
      grams,
      iliSpent: iliSpend,
      iliPerGram,
      goldPriceToman: goldToman,
      goldBalanceGrams: row.gold_balance,
      iliBalance: row.balance
    });
  } catch (err) {
    console.error('[GOLD BUY]', err);
    res.status(500).json({ error: 'خطا در خرید طلا' });
  }
});

app.post('/api/gold/sell', requireAuth, (req, res) => {
  try {
    ensureSchema();
    const grams = Number((req.body || {}).grams);
    if (!Number.isFinite(grams) || grams <= 0) {
      return res.status(400).json({ error: 'مقدار گرم نامعتبر است' });
    }
    const user = getUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'ورود لازم است' });
    const row = db.prepare('SELECT gold_balance, balance FROM users WHERE id = ?').get(user.id);
    const bal = row && row.gold_balance != null ? row.gold_balance : 0;
    if (bal + 1e-12 < grams) {
      return res.status(400).json({ error: 'موجودی طلا کافی نیست' });
    }
    let goldToman = getGoldPriceTomanSync();
    if (!goldToman) return res.status(503).json({ error: 'قیمت طلا در دسترس نیست' });
    const ili = getIliPriceToman();
    const iliPerGram = Math.floor(goldToman / ili);
    const iliReceive = Math.floor(grams * iliPerGram);
    if (iliReceive < 1) return res.status(400).json({ error: 'مقدار فروش خیلی کم است' });

    db.transaction(() => {
      db.prepare('UPDATE users SET gold_balance = gold_balance - ? WHERE id = ?').run(grams, user.id);
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(iliReceive, user.id);
      db.prepare(`
        INSERT INTO gold_trades (user_id, side, grams, ili_amount, gold_price_toman, ili_price_toman)
        VALUES (?, 'SELL', ?, ?, ?, ?)
      `).run(user.id, grams, iliReceive, goldToman, ili);
      db.prepare(`
        INSERT INTO transactions (user_id, type, amount, status, note)
        VALUES (?, 'GOLD_SELL', ?, 'APPROVED', ?)
      `).run(user.id, iliReceive, `فروش ${grams.toFixed(6)} گرم طلای دیجیتال`);
    })();

    const after = db.prepare('SELECT gold_balance, balance FROM users WHERE id = ?').get(user.id);
    audit(user.id, 'GOLD_SELL', { grams, iliReceive, goldToman, ili });
    try { applySellPriceImpact(iliReceive); } catch (e) {}
    res.json({
      message: 'فروش طلا انجام شد',
      grams,
      iliReceived: iliReceive,
      iliPerGram,
      goldBalanceGrams: after.gold_balance,
      iliBalance: after.balance
    });
  } catch (err) {
    console.error('[GOLD SELL]', err);
    res.status(500).json({ error: 'خطا در فروش طلا' });
  }
});

app.get('/api/gold/history', requireAuth, (req, res) => {
  try {
    ensureSchema();
    const rows = db.prepare(`
      SELECT id, side, grams, ili_amount, gold_price_toman, ili_price_toman, created_at
      FROM gold_trades WHERE user_id = ? ORDER BY id DESC LIMIT 50
    `).all(req.session.userId);
    res.json({ trades: rows });
  } catch (err) {
    res.json({ trades: [] });
  }
});

// Fallback for SPA-like routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function getLanIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

app.listen(PORT, HOST, () => {
  const lan = getLanIPv4();
  console.log('');
  console.log('ILI Home Banking started successfully.');
  console.log('');
  console.log('Local:');
  console.log(`http://localhost:${PORT}`);
  if (lan) {
    console.log('');
    console.log('LAN:');
    console.log(`http://${lan}:${PORT}`);
  }
  console.log('');
  console.log(`Database: ${dbPath}`);
  console.log('');
});
