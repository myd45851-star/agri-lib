'use strict';
/*
 * مكتبة محاضرات وسكاشن قسم هندسة الزراعة والحيوية
 * سيرفر Express + SQLite: حسابات، طلبات انضمام بموافقة الأدمن، إشعارات، رفع وتحميل ملفات محمية.
 */
const express = require('express');
const multer = require('multer');
/* قاعدة البيانات المدمجة في Node (22.13 أو أحدث): مفيش حزم native محتاجة تتبني على جهازك */
const origEmitWarning = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  if (typeof w === 'string' && w.includes('SQLite')) return;
  return origEmitWarning.call(process, w, ...rest);
};
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ---------- الإعدادات ---------- */
function loadEnv(file) {
  try {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith('#')) return;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    });
  } catch (e) { /* لا يوجد ملف .env */ }
}
loadEnv(path.join(__dirname, '.env'));

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MAX_MB = Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '100', 10));
const NTFY_TOPIC = (process.env.NTFY_TOPIC || '').trim();
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const ADMIN_USER = (process.env.ADMIN_USER || 'admin').trim().toLowerCase();
const PROD = process.env.NODE_ENV === 'production';

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const DIVS = ['irr', 'bio', 'pow', 'gen'];
const KINDS = { lec: 'محاضرة', sec: 'سكشن' };
const SLOTS = 11;

/* أنواع الملفات المسموحة: [نوع المحتوى، يُعرض داخل المتصفح؟]. لا يوجد HTML أو SVG أو JS عن قصد. */
const TYPES = {
  pdf: ['application/pdf', true],
  png: ['image/png', true], jpg: ['image/jpeg', true], jpeg: ['image/jpeg', true], gif: ['image/gif', true], webp: ['image/webp', true],
  mp4: ['video/mp4', true], webm: ['video/webm', true], mp3: ['audio/mpeg', true],
  txt: ['text/plain; charset=utf-8', true], csv: ['text/csv; charset=utf-8', false],
  doc: ['application/msword', false],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', false],
  ppt: ['application/vnd.ms-powerpoint', false],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', false],
  xls: ['application/vnd.ms-excel', false],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', false],
  zip: ['application/zip', false], rar: ['application/vnd.rar', false],
};
const extOf = (name) => (String(name).split('.').pop() || '').toLowerCase();

/* ---------- قاعدة البيانات ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'library.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, name TEXT NOT NULL, login TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, decided_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS subjects(id TEXT PRIMARY KEY, div TEXT NOT NULL, name TEXT NOT NULL, sort INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS slots(
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE, kind TEXT NOT NULL, n INTEGER NOT NULL, title TEXT NOT NULL,
  file_name TEXT, stored TEXT, mime TEXT, size INTEGER, link_url TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(subject_id, kind, n));
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, user_id INTEGER, created_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0);
`);

/* ---------- كلمات المرور والجلسات ---------- */
const newSalt = () => crypto.randomBytes(16).toString('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function checkPw(pw, salt, hash) {
  const a = Buffer.from(hashPw(pw, salt), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const DUMMY_SALT = newSalt();
const DUMMY_HASH = hashPw('dummy-password', DUMMY_SALT);
const hashTok = (t) => crypto.createHash('sha256').update(t).digest('hex');

function bootstrapAdmin() {
  const existing = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get();
  let pw = process.env.ADMIN_PASSWORD || '';
  if (existing) {
    if (process.env.RESET_ADMIN_PASSWORD === '1' && pw.length >= 8) {
      const salt = newSalt();
      db.prepare('UPDATE users SET salt=?, hash=?, login=? WHERE id=?').run(salt, hashPw(pw, salt), ADMIN_USER, existing.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(existing.id);
      console.log('تم تحديث بيانات دخول الأدمن. شيل RESET_ADMIN_PASSWORD من ملف .env.');
    }
    return;
  }
  let generated = false;
  if (pw.length < 8) { pw = crypto.randomBytes(9).toString('base64url'); generated = true; }
  const salt = newSalt();
  db.prepare("INSERT INTO users(role,name,login,salt,hash,status,created_at) VALUES('admin','الأدمن',?,?,?,'approved',?)")
    .run(ADMIN_USER, salt, hashPw(pw, salt), Date.now());
  console.log('تم إنشاء حساب الأدمن. اسم المستخدم: ' + ADMIN_USER);
  if (generated) console.log('كلمة المرور (اكتبها دلوقتي، مش هتظهر تاني): ' + pw);
}
bootstrapAdmin();

/* ---------- مواد الجدول (قابلة للتعديل من لوحة الأدمن) ---------- */
function seedSubjects() {
  if (db.prepare('SELECT COUNT(*) c FROM subjects').get().c > 0) return;
  const ENV = 'التحكم البيئي في المنشآت الزراعية', SOIL = 'ميكانيكا التربة', VIB = 'نظرية الاهتزاز والتوازن',
    IRD = 'تصميم نظم الري', FERT = 'معدات التسميد والمكافحة', MD = 'تصميم الآلات الزراعية',
    DRN = 'تخطيط وتصميم نظم الصرف الزراعي', HYD = 'هيدروليكا الآبار والمضخات', PROP = 'الخصائص الطبيعية والهندسية',
    COMP = 'هندسة تصنيع السماد العضوي المكمور', HYDRO = 'إدارة وتشغيل المزارع المائية', RES = 'أساليب البحث العلمي';
  const plan = {
    irr: [ENV, SOIL, IRD, HYD, DRN, MD, RES],
    bio: [ENV, PROP, COMP, HYDRO, IRD, MD, RES],
    pow: [ENV, SOIL, VIB, IRD, FERT, MD, RES],
    gen: [ENV, FERT, COMP, DRN, IRD, MD, RES],
  };
  const ins = db.prepare('INSERT INTO subjects(id,div,name,sort) VALUES(?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const div of DIVS) plan[div].forEach((name, i) => ins.run(`${div}-s${String(i + 1).padStart(2, '0')}`, div, name, i + 1));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
seedSubjects();

/* ---------- إشعارات ---------- */
function notify(text, userId) {
  db.prepare('INSERT INTO notifications(text,user_id,created_at) VALUES(?,?,?)').run(text, userId || null, Date.now());
  if (!NTFY_TOPIC) return;
  fetch(`${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: 'POST',
    headers: { Title: 'New access request', Tags: 'bell', 'Content-Type': 'text/plain; charset=utf-8' },
    body: text,
    signal: AbortSignal.timeout(6000),
  }).catch(() => {});
}

/* ---------- أدوات ---------- */
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n += 1;
  return b.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}, 10 * 60 * 1000).unref();

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name });

/* ---------- التطبيق ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY !== undefined ? (process.env.TRUST_PROXY === 'false' ? false : Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY) : (PROD ? 1 : false));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});
app.use(express.json({ limit: '20kb' }));

/* حماية CSRF: أي طلب يغيّر بيانات لازم يحمل هيدر مخصوص ومن نفس الموقع */
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  if (origin) {
    try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'bad_origin' }); }
    catch (e) { return res.status(403).json({ error: 'bad_origin' }); }
  }
  if (req.get('x-requested-with') !== 'fetch') return res.status(403).json({ error: 'bad_request' });
  next();
});

/* المصادقة */
app.use((req, res, next) => {
  req.user = null;
  const tok = getCookie(req, 'sid');
  if (tok) {
    const row = db.prepare('SELECT u.*, s.expires_at AS exp FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(hashTok(tok));
    if (row && row.exp > Date.now() && (row.role === 'admin' || row.status === 'approved')) req.user = row;
  }
  next();
});
const needUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'login_required' }));
const needAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(req.user ? 403 : 401).json({ error: 'forbidden' }));

function startSession(req, res, user) {
  const tok = crypto.randomBytes(32).toString('hex');
  const ttl = (user.role === 'admin' ? 24 : 24 * 14) * 3600 * 1000;
  db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(hashTok(tok), user.id, Date.now() + ttl);
  res.cookie('sid', tok, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: ttl, path: '/' });
}

/* ---------- API عامة ---------- */
app.post('/api/register', (req, res) => {
  if (limited('reg:' + req.ip, 8, 3600 * 1000)) return res.status(429).json({ error: 'too_many' });
  const name = cleanName(req.body.name);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const words = name.split(' ').filter((w) => w.length >= 2);
  if (words.length < 2 || name.length > 80) return res.status(400).json({ error: 'bad_name' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) return res.status(400).json({ error: 'bad_email' });
  if (password.length < 8 || password.length > 100) return res.status(400).json({ error: 'bad_password' });
  if (db.prepare('SELECT 1 FROM users WHERE login=?').get(email)) return res.status(409).json({ error: 'exists' });
  const salt = newSalt();
  const info = db.prepare("INSERT INTO users(role,name,login,salt,hash,status,created_at) VALUES('student',?,?,?,?,'pending',?)")
    .run(name, email, salt, hashPw(password, salt), Date.now());
  notify('طلب انضمام جديد: ' + name + ' (' + email + ')', info.lastInsertRowid);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const login = String(req.body.login || '').trim().toLowerCase().slice(0, 120);
  const password = String(req.body.password || '').slice(0, 100);
  if (limited('login:' + req.ip, 30, 15 * 60 * 1000) || limited('login:' + login, 8, 15 * 60 * 1000)) return res.status(429).json({ error: 'too_many' });
  const u = db.prepare('SELECT * FROM users WHERE login=?').get(login);
  const ok = checkPw(password, u ? u.salt : DUMMY_SALT, u ? u.hash : DUMMY_HASH);
  if (!u || !ok) return res.status(401).json({ error: 'bad_credentials' });
  if (u.role !== 'admin' && u.status !== 'approved') return res.json({ ok: false, status: u.status, reason: u.reason || '' });
  startSession(req, res, u);
  res.json({ ok: true, user: publicUser(u) });
});

app.post('/api/logout', (req, res) => {
  const tok = getCookie(req, 'sid');
  if (tok) db.prepare('DELETE FROM sessions WHERE token=?').run(hashTok(tok));
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));

/* ---------- المكتبة (للمعتمدين والأدمن) ---------- */
app.get('/api/library', needUser, (req, res) => {
  const subjects = db.prepare('SELECT id, div, name, sort FROM subjects ORDER BY sort, name').all();
  const slots = db.prepare('SELECT subject_id, kind, n, title, file_name, mime, size, link_url, updated_at, (stored IS NOT NULL) AS has_file FROM slots').all()
    .map((s) => ({ subject_id: s.subject_id, kind: s.kind, n: s.n, title: s.title, file_name: s.file_name, mime: s.mime, size: s.size, link_url: s.link_url, updated_at: s.updated_at, file: !!s.has_file }));
  res.json({ subjects, slots, maxMb: MAX_MB, types: Object.keys(TYPES) });
});

app.get('/files/:sid/:kind/:n', needUser, (req, res) => {
  const n = parseInt(req.params.n, 10);
  const s = db.prepare('SELECT * FROM slots WHERE subject_id=? AND kind=? AND n=?').get(req.params.sid, req.params.kind, n);
  if (!s || !s.stored) return res.status(404).send('غير موجود');
  const full = path.join(UPLOAD_DIR, path.basename(s.stored));
  if (!fs.existsSync(full)) return res.status(404).send('غير موجود');
  const ext = extOf(s.stored);
  const t = TYPES[ext] || ['application/octet-stream', false];
  const wantDownload = req.query.dl === '1' || !t[1];
  let fname = (s.title || 'material').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || 'material';
  if (extOf(fname) !== ext) fname += '.' + ext;
  res.set({
    'Content-Type': t[0],
    'Content-Disposition': (wantDownload ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(fname),
    'Cache-Control': 'private, max-age=0, must-revalidate',
  });
  res.sendFile(full, { dotfiles: 'allow' });
});

/* ---------- API الأدمن ---------- */
app.get('/api/admin/summary', needAdmin, (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  const pending = db.prepare("SELECT COUNT(*) c FROM users WHERE role='student' AND status='pending'").get().c;
  const maxId = db.prepare('SELECT COALESCE(MAX(id),0) m FROM notifications').get().m;
  const latest = db.prepare('SELECT id, text, created_at FROM notifications WHERE id>? ORDER BY id LIMIT 20').all(since);
  res.json({ pending, maxId, latest, ntfy: !!NTFY_TOPIC });
});

app.get('/api/admin/users', needAdmin, (req, res) => {
  const list = db.prepare("SELECT id, name, login AS email, status, reason, created_at, decided_at FROM users WHERE role='student' ORDER BY created_at DESC").all();
  res.json({ users: list });
});

function studentById(id) {
  return db.prepare("SELECT * FROM users WHERE id=? AND role='student'").get(parseInt(id, 10));
}
app.post('/api/admin/users/:id/:action(approve|reject|revoke)', needAdmin, (req, res) => {
  const u = studentById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  const map = { approve: 'approved', reject: 'rejected', revoke: 'revoked' };
  const status = map[req.params.action];
  const reason = status === 'approved' ? null : cleanName(req.body.reason).slice(0, 200) || null;
  db.prepare('UPDATE users SET status=?, reason=?, decided_at=? WHERE id=?').run(status, reason, Date.now(), u.id);
  if (status !== 'approved') db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  res.json({ ok: true });
});
app.delete('/api/admin/users/:id', needAdmin, (req, res) => {
  const u = studentById(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  res.json({ ok: true });
});

app.post('/api/admin/password', needAdmin, (req, res) => {
  const cur = String(req.body.current || ''), next = String(req.body.next || '');
  if (limited('pw:' + req.user.id, 10, 15 * 60 * 1000)) return res.status(429).json({ error: 'too_many' });
  if (!checkPw(cur, req.user.salt, req.user.hash)) return res.status(401).json({ error: 'bad_credentials' });
  if (next.length < 10 || next.length > 100) return res.status(400).json({ error: 'bad_password' });
  const salt = newSalt();
  db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hashPw(next, salt), req.user.id);
  const keep = hashTok(getCookie(req, 'sid'));
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(req.user.id, keep);
  res.json({ ok: true });
});

/* المواد الدراسية */
app.post('/api/admin/subjects', needAdmin, (req, res) => {
  const div = String(req.body.div || ''), name = cleanName(req.body.name).slice(0, 90);
  if (!DIVS.includes(div) || !name) return res.status(400).json({ error: 'bad_request' });
  const id = div + '-' + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO subjects(id,div,name,sort) VALUES(?,?,?,?)').run(id, div, name, Date.now());
  res.json({ ok: true, id });
});
app.put('/api/admin/subjects/:id', needAdmin, (req, res) => {
  const name = cleanName(req.body.name).slice(0, 90);
  if (!name) return res.status(400).json({ error: 'bad_request' });
  const r = db.prepare('UPDATE subjects SET name=? WHERE id=?').run(name, req.params.id);
  res.status(r.changes ? 200 : 404).json({ ok: !!r.changes });
});
app.delete('/api/admin/subjects/:id', needAdmin, (req, res) => {
  if (db.prepare('SELECT COUNT(*) c FROM slots WHERE subject_id=?').get(req.params.id).c > 0) return res.status(409).json({ error: 'has_files' });
  const r = db.prepare('DELETE FROM subjects WHERE id=?').run(req.params.id);
  res.status(r.changes ? 200 : 404).json({ ok: !!r.changes });
});

/* رفع المواد */
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1, fields: 8 },
  fileFilter: (req, file, cb) => {
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (!TYPES[extOf(file.originalname)]) return cb(Object.assign(new Error('unsupported'), { code: 'UNSUPPORTED' }));
    cb(null, true);
  },
});
const unlinkQuiet = (p) => { try { fs.unlinkSync(p); } catch (e) { /* تجاهل */ } };

app.put('/api/admin/slots/:sid/:kind/:n', needAdmin, upload.single('file'), (req, res) => {
  const tmp = req.file && req.file.path;
  try {
    const { sid, kind } = req.params;
    const n = parseInt(req.params.n, 10);
    if (!KINDS[kind] || !(n >= 1 && n <= SLOTS) || !db.prepare('SELECT 1 FROM subjects WHERE id=?').get(sid)) return res.status(400).json({ error: 'bad_request' });
    const old = db.prepare('SELECT * FROM slots WHERE subject_id=? AND kind=? AND n=?').get(sid, kind, n);
    const title = cleanName(req.body.title).slice(0, 120) || `${KINDS[kind]} ${n}`;
    const rec = { file_name: null, stored: null, mime: null, size: null, link_url: null };
    if (String(req.body.mode) === 'link') {
      const link = String(req.body.link || '').trim();
      if (!/^https?:\/\/\S+$/i.test(link) || link.length > 500) return res.status(400).json({ error: 'bad_link' });
      rec.link_url = link;
    } else if (req.file) {
      const ext = extOf(req.file.originalname);
      const stored = crypto.randomBytes(16).toString('hex') + '.' + ext;
      fs.renameSync(req.file.path, path.join(UPLOAD_DIR, stored));
      rec.file_name = req.file.originalname.slice(0, 200); rec.stored = stored; rec.mime = TYPES[ext][0]; rec.size = req.file.size;
    } else if (old && old.stored) {
      Object.assign(rec, { file_name: old.file_name, stored: old.stored, mime: old.mime, size: old.size });
    } else {
      return res.status(400).json({ error: 'no_file' });
    }
    db.prepare(`INSERT INTO slots(subject_id,kind,n,title,file_name,stored,mime,size,link_url,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(subject_id,kind,n) DO UPDATE SET title=excluded.title,file_name=excluded.file_name,stored=excluded.stored,mime=excluded.mime,size=excluded.size,link_url=excluded.link_url,updated_at=excluded.updated_at`)
      .run(sid, kind, n, title, rec.file_name, rec.stored, rec.mime, rec.size, rec.link_url, Date.now());
    if (old && old.stored && old.stored !== rec.stored) unlinkQuiet(path.join(UPLOAD_DIR, path.basename(old.stored)));
    res.json({ ok: true });
  } finally {
    if (tmp && fs.existsSync(tmp)) unlinkQuiet(tmp);
  }
});
app.delete('/api/admin/slots/:sid/:kind/:n', needAdmin, (req, res) => {
  const n = parseInt(req.params.n, 10);
  const old = db.prepare('SELECT * FROM slots WHERE subject_id=? AND kind=? AND n=?').get(req.params.sid, req.params.kind, n);
  if (!old) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM slots WHERE subject_id=? AND kind=? AND n=?').run(req.params.sid, req.params.kind, n);
  if (old.stored) unlinkQuiet(path.join(UPLOAD_DIR, path.basename(old.stored)));
  res.json({ ok: true });
});

/* ---------- الملفات الثابتة ---------- */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m', index: 'index.html' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'too_large', maxMb: MAX_MB });
  if (err && err.code === 'UNSUPPORTED') return res.status(400).json({ error: 'unsupported' });
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) return res.status(400).json({ error: 'bad_request' });
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

app.listen(PORT, HOST, () => {
  console.log(`المكتبة شغالة على http://localhost:${PORT}`);
  if (NTFY_TOPIC) console.log('إشعارات الموبايل (ntfy) مفعلة.');
});
