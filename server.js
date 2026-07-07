// Car Booking System — standalone server
// Zero external dependencies: just Node.js (v14+) is required to run this.
//
// Run:   node server.js
// Then open:  http://localhost:3000   (or the PORT you set)
//
// Data is stored in ./data/db.json — back this file up / put it on a
// persistent disk when you deploy, or your bookings will disappear on restart.

const http = require('http');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234'; // change this, or set env var ADMIN_PASSWORD
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- small helpers ----------

// Always compute "today" in Asia/Bangkok, regardless of where the server is hosted.
function todayStr() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date()); // en-CA gives YYYY-MM-DD
}

function timesOverlap(s1, e1, s2, e2) {
  return s1 < e2 && s2 < e1;
}

function isValidTime(v) {
  return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);
}
function isValidDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// ---------- data persistence (simple mutex so concurrent requests don't clobber each other) ----------

async function ensureDB() {
  if (!fsSync.existsSync(DATA_DIR)) await fs.mkdir(DATA_DIR, { recursive: true });
  if (!fsSync.existsSync(DB_PATH)) {
    await fs.writeFile(DB_PATH, JSON.stringify({ cars: [], drivers: [], bookings: [] }, null, 2));
  }
}

async function loadDB() {
  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      cars: Array.isArray(parsed.cars) ? parsed.cars : [],
      drivers: Array.isArray(parsed.drivers) ? parsed.drivers : [],
      bookings: Array.isArray(parsed.bookings) ? parsed.bookings : [],
    };
  } catch (e) {
    return { cars: [], drivers: [], bookings: [] };
  }
}

async function saveDB(db) {
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

let dbLock = Promise.resolve();
// mutator: async (db) => ({ status, body, changed })
function withDB(mutator) {
  const run = dbLock.then(async () => {
    const db = await loadDB();
    const { status, body, changed } = await mutator(db);
    if (changed) await saveDB(db);
    return { status, body };
  });
  // keep the chain alive even if one request throws
  dbLock = run.then(() => {}, () => {});
  return run;
}

// ---------- request body parsing ----------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1e6) { reject(new Error('Body too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function requireAdmin(payload) {
  return payload && payload.password === ADMIN_PASSWORD;
}

// ---------- API handlers ----------

async function handleApi(req, res, pathname) {
  let payload = {};
  if (req.method === 'POST') {
    try { payload = await readJsonBody(req); }
    catch (e) { return sendJson(res, 400, { error: 'BAD_JSON' }); }
  }

  // GET /api/state -> public data (cars, drivers, and only non-archived bookings)
  if (pathname === '/api/state' && req.method === 'GET') {
    const db = await loadDB();
    return sendJson(res, 200, {
      cars: db.cars,
      drivers: db.drivers,
      bookings: db.bookings.filter(b => !b.archived),
      today: todayStr(),
    });
  }

  // POST /api/admin/login {password}
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    if (!requireAdmin(payload)) return sendJson(res, 401, { error: 'WRONG_PASSWORD' });
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/admin/history?date=YYYY-MM-DD&password=...
  if (pathname === '/api/admin/history' && req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const date = url.searchParams.get('date');
    const password = url.searchParams.get('password');
    if (!requireAdmin({ password })) return sendJson(res, 401, { error: 'WRONG_PASSWORD' });
    if (!isValidDate(date)) return sendJson(res, 400, { error: 'BAD_DATE' });
    const db = await loadDB();
    const list = db.bookings.filter(b => b.date === date && b.archived);
    return sendJson(res, 200, { bookings: list });
  }

  // POST /api/cars/add {plate, note, password}
  if (pathname === '/api/cars/add' && req.method === 'POST') {
    return withDB(async (db) => {
      if (!requireAdmin(payload)) return { status: 401, body: { error: 'WRONG_PASSWORD' }, changed: false };
      const plate = String(payload.plate || '').trim();
      const note = String(payload.note || '').trim();
      if (!plate) return { status: 400, body: { error: 'PLATE_REQUIRED' }, changed: false };
      if (db.cars.some(c => c.plate.toLowerCase() === plate.toLowerCase())) {
        return { status: 409, body: { error: 'PLATE_DUPLICATE' }, changed: false };
      }
      db.cars.push({ plate, note });
      return { status: 200, body: { ok: true, cars: db.cars }, changed: true };
    }).then(({ status, body }) => sendJson(res, status, body));
  }

  // POST /api/cars/remove {plate, password}
  if (pathname === '/api/cars/remove' && req.method === 'POST') {
    return withDB(async (db) => {
      if (!requireAdmin(payload)) return { status: 401, body: { error: 'WRONG_PASSWORD' }, changed: false };
      const plate = String(payload.plate || '');
      const before = db.cars.length;
      db.cars = db.cars.filter(c => c.plate !== plate);
      return { status: 200, body: { ok: true, cars: db.cars }, changed: db.cars.length !== before };
    }).then(({ status, body }) => sendJson(res, status, body));
  }

  // POST /api/drivers/add {name, note, password}
  if (pathname === '/api/drivers/add' && req.method === 'POST') {
    return withDB(async (db) => {
      if (!requireAdmin(payload)) return { status: 401, body: { error: 'WRONG_PASSWORD' }, changed: false };
      const name = String(payload.name || '').trim();
      const note = String(payload.note || '').trim();
      if (!name) return { status: 400, body: { error: 'NAME_REQUIRED' }, changed: false };
      if (db.drivers.some(d => d.name.toLowerCase() === name.toLowerCase())) {
        return { status: 409, body: { error: 'NAME_DUPLICATE' }, changed: false };
      }
      db.drivers.push({ name, note });
      return { status: 200, body: { ok: true, drivers: db.drivers }, changed: true };
    }).then(({ status, body }) => sendJson(res, status, body));
  }

  // POST /api/drivers/remove {name, password}
  if (pathname === '/api/drivers/remove' && req.method === 'POST') {
    return withDB(async (db) => {
      if (!requireAdmin(payload)) return { status: 401, body: { error: 'WRONG_PASSWORD' }, changed: false };
      const name = String(payload.name || '');
      const before = db.drivers.length;
      db.drivers = db.drivers.filter(d => d.name !== name);
      return { status: 200, body: { ok: true, drivers: db.drivers }, changed: db.drivers.length !== before };
    }).then(({ status, body }) => sendJson(res, status, body));
  }

  // POST /api/bookings/add {requester, driver, plate, date, start, end}
  if (pathname === '/api/bookings/add' && req.method === 'POST') {
    return withDB(async (db) => {
      const requester = String(payload.requester || '').trim();
      const driver = String(payload.driver || '').trim();
      const plate = String(payload.plate || '').trim();
      const date = String(payload.date || '').trim();
      const start = String(payload.start || '').trim();
      const end = String(payload.end || '').trim();

      if (!requester) return { status: 400, body: { error: 'REQUESTER_REQUIRED' }, changed: false };
      if (!driver) return { status: 400, body: { error: 'DRIVER_REQUIRED' }, changed: false };
      if (!plate) return { status: 400, body: { error: 'CAR_REQUIRED' }, changed: false };
      if (!isValidDate(date)) return { status: 400, body: { error: 'DATE_INVALID' }, changed: false };
      if (!isValidTime(start) || !isValidTime(end)) return { status: 400, body: { error: 'TIME_REQUIRED' }, changed: false };
      if (end <= start) return { status: 400, body: { error: 'TIME_RANGE_INVALID' }, changed: false };
      if (!db.cars.some(c => c.plate === plate)) return { status: 400, body: { error: 'CAR_NOT_FOUND' }, changed: false };
      if (!db.drivers.some(d => d.name === driver)) return { status: 400, body: { error: 'DRIVER_NOT_FOUND' }, changed: false };

      const carConflict = db.bookings.find(b => b.plate === plate && b.date === date && !b.archived && timesOverlap(start, end, b.start, b.end));
      if (carConflict) return { status: 409, body: { error: 'CAR_CONFLICT', conflict: carConflict }, changed: false };

      const driverNorm = driver.toLowerCase();
      const driverConflict = db.bookings.find(b => b.driver.toLowerCase() === driverNorm && b.date === date && !b.archived && timesOverlap(start, end, b.start, b.end));
      if (driverConflict) return { status: 409, body: { error: 'DRIVER_CONFLICT', conflict: driverConflict }, changed: false };

      const booking = {
        id: 'bk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        requester, driver, plate, date, start, end, archived: false, createdAt: Date.now(),
      };
      db.bookings.push(booking);
      return { status: 200, body: { ok: true, booking }, changed: true };
    }).then(({ status, body }) => sendJson(res, status, body));
  }

  // POST /api/bookings/cancel {id, password}
  if (pathname === '/api/bookings/cancel' && req.method === 'POST') {
    return withDB(async (db) => {
      if (!requireAdmin(payload)) return { status: 401, body: { error: 'WRONG_PASSWORD' }, changed: false };
      const id = String(payload.id || '');
      const before = db.bookings.length;
      db.bookings = db.bookings.filter(b => b.id !== id);
      return { status: 200, body: { ok: true }, changed: db.bookings.length !== before };
    }).then(({ status, body }) => sendJson(res, status, body));
  }

  // POST /api/admin/end-day {password}
  if (pathname === '/api/admin/end-day' && req.method === 'POST') {
    return withDB(async (db) => {
      if (!requireAdmin(payload)) return { status: 401, body: { error: 'WRONG_PASSWORD' }, changed: false };
      const d = todayStr();
      let count = 0;
      db.bookings = db.bookings.map(b => {
        if (b.date === d && !b.archived) { count++; return { ...b, archived: true }; }
        return b;
      });
      return { status: 200, body: { ok: true, count }, changed: count > 0 };
    }).then(({ status, body }) => sendJson(res, status, body));
  }

  return sendJson(res, 404, { error: 'NOT_FOUND' });
}

// ---------- static file serving ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function handleStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else {
      await handleStatic(req, res, pathname);
    }
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: 'SERVER_ERROR' });
  }
});

ensureDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Car booking system running at http://localhost:${PORT}`);
    console.log(`Admin password: ${ADMIN_PASSWORD} (set env var ADMIN_PASSWORD to change)`);
  });
});
