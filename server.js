require('dotenv').config({ path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env' }); // 환경에 따라 자동 로드
/**
 * ================================================================
 * AsomeScorePlayer — Server
 * ================================================================
 * 밴드 악보 자동 넘김 & 실시간 동기화 서버
 *
 * 주요 기능:
 *   - 곡/파트/악보 CRUD API (SQLite via sql.js)
 *   - PDF 악보 업로드 및 오선 감지 데이터 관리
 *   - Socket.IO 기반 멀티 세션 실시간 동기화
 *     (재생/정지/일시정지/시크/템포 변경)
 *   - 파트별 스타일 설정 저장
 *
 * 포트: 3001 (ngrok으로 외부 접속)
 * DB: data/bandscore.db (SQLite)
 * ================================================================
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const initSqlJs = require('sql.js');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

// JWT 설정
const JWT_SECRET = process.env.JWT_SECRET || 'backstage_jwt_secret_2026_do_not_share';
const JWT_EXPIRES = '7d';
const ADMIN_EMAIL = 'chuli8944@gmail.com';

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3001;
// 프로세스 안정화: 미처리 예외/거부 시 로그만 남기고 프로세스 유지
process.on('uncaughtException', err => console.error('⚠️ Uncaught:', err.message));
process.on('unhandledRejection', err => console.error('⚠️ Unhandled:', err));
process.on('SIGTERM', () => { console.log('🛑 SIGTERM received, shutting down...'); process.exit(0); });

// Directories
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
[uploadsDir, dataDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Middleware
app.use(express.json());

// Clean URL routes (확장자 없이 접근)
const cleanRoutes = ['login', 'guide', 'player', 'taskboard', 'profile', 'admin', 'reset-password'];
cleanRoutes.forEach(name => {
  app.get(`/${name}`, (req, res) => {
    const filePath = path.join(__dirname, 'public', `${name}.html`);
    if (fs.existsSync(filePath)) res.sendFile(filePath);
    else res.status(404).send('Page not found');
  });
});
// 초대 URL: /invite/:code → 로그인 페이지로 이동 (초대코드 포함)
app.get('/invite/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// Multer
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, fileFilter: (req, file, cb) => {
  cb(null, file.mimetype === 'application/pdf');
}});
const uploadAny = multer({ storage });

// Database (sql.js - pure JS SQLite)
let db;
const dbPath = path.join(dataDir, 'bandscore.db');

function saveDb() {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function get(sql, params = []) {
  const rows = query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON');
  db.run(`CREATE TABLE IF NOT EXISTS songs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, bpm INTEGER DEFAULT 120,
    time_signature TEXT DEFAULT '4/4', count_in_bars INTEGER DEFAULT 2,
    cover_filename TEXT, inst_filename TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // sort_order 컬럼 마이그레이션
  try { db.run(`ALTER TABLE songs ADD COLUMN sort_order INTEGER DEFAULT 0`); } catch(e) {}
  db.run(`CREATE TABLE IF NOT EXISTS parts (
    id TEXT PRIMARY KEY, song_id TEXT NOT NULL, name TEXT NOT NULL,
    pdf_filename TEXT NOT NULL, original_filename TEXT, total_pages INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS page_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT, part_id TEXT NOT NULL,
    page_number INTEGER NOT NULL, measures INTEGER DEFAULT 4,
    FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE,
    UNIQUE(part_id, page_number)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT, song_id TEXT NOT NULL,
    name TEXT NOT NULL, start_measure INTEGER NOT NULL, end_measure INTEGER NOT NULL,
    order_index INTEGER DEFAULT 0,
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS song_flow (
    id INTEGER PRIMARY KEY AUTOINCREMENT, song_id TEXT NOT NULL,
    section_name TEXT NOT NULL, order_index INTEGER NOT NULL,
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS staff_systems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id TEXT NOT NULL,
    page_number INTEGER NOT NULL,
    system_index INTEGER NOT NULL,
    top_pct REAL NOT NULL,
    bottom_pct REAL NOT NULL,
    measures INTEGER DEFAULT 2,
    repeat_start_at INTEGER DEFAULT 0,
    repeat_end_at INTEGER DEFAULT 0,
    volta INTEGER DEFAULT 0,
    volta_from INTEGER DEFAULT 0,
    volta_to INTEGER DEFAULT 0,
    FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS part_playback_order (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    page_number INTEGER NOT NULL,
    FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE CASCADE
  )`);
  // ── Users 테이블 ──
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    nickname TEXT NOT NULL,
    profile_image TEXT,
    provider TEXT DEFAULT 'local',
    provider_id TEXT,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
  )`);
  // ── Stages 테이블 ──
  db.run(`CREATE TABLE IF NOT EXISTS stages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    cover_image TEXT,
    created_by TEXT NOT NULL,
    invite_code TEXT UNIQUE,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS stage_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'viewer',
    joined_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (stage_id) REFERENCES stages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(stage_id, user_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS stage_invitations (
    id TEXT PRIMARY KEY,
    stage_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    expires_at TEXT,
    max_uses INTEGER DEFAULT 0,
    use_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (stage_id) REFERENCES stages(id) ON DELETE CASCADE
  )`);
  // ── Stage 채팅 메시지 테이블 ──
  db.run(`CREATE TABLE IF NOT EXISTS stage_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (stage_id) REFERENCES stages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  // ── DM 테이블 ──
  db.run(`CREATE TABLE IF NOT EXISTS direct_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    message TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  // ── 비밀번호 재설정 토큰 테이블 ──
  db.run(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  saveDb();
  // Migration: 기존 DB에 새 컬럼 추가
  try { db.run('ALTER TABLE songs ADD COLUMN cover_filename TEXT'); saveDb(); } catch(e) {}
  try { db.run('ALTER TABLE songs ADD COLUMN inst_filename TEXT'); saveDb(); } catch(e) {}
  try { db.run('ALTER TABLE songs ADD COLUMN inst_delay_ms INTEGER DEFAULT 0'); saveDb(); } catch(e) {}
  try { db.run('ALTER TABLE parts ADD COLUMN style_settings TEXT'); saveDb(); } catch(e) {}
  // users 테이블 마이그레이션
  try { db.run('ALTER TABLE users ADD COLUMN role TEXT DEFAULT \'user\''); saveDb(); } catch(e) {}
  try { db.run('ALTER TABLE users ADD COLUMN last_login TEXT'); saveDb(); } catch(e) {}
  // songs에 stage_id 추가 (기존 곡은 NULL → 나중에 이관)
  try { db.run('ALTER TABLE songs ADD COLUMN stage_id TEXT'); saveDb(); } catch(e) {}

  // ── 기존 곡 데이터 이관: stage_id가 NULL인 곡 → '성수역 6번출구' Stage ──
  const orphanSongs = query("SELECT id FROM songs WHERE stage_id IS NULL");
  if (orphanSongs.length > 0) {
    console.log(`📦 기존 곡 ${orphanSongs.length}개 이관 시작...`);
    // admin 계정 확인/생성
    let adminUser = get("SELECT id FROM users WHERE email = ?", [ADMIN_EMAIL]);
    if (!adminUser) {
      const adminId = uuidv4();
      const hash = bcrypt.hashSync('admin1234', 10);
      db.run("INSERT INTO users (id, email, password_hash, nickname, role) VALUES (?, ?, ?, ?, 'admin')",
        [adminId, ADMIN_EMAIL, hash, 'chuli']);
      adminUser = { id: adminId };
      console.log('  → admin 계정 자동 생성');
    }
    // '성수역 6번출구' Stage 확인/생성
    let defaultStage = get("SELECT id FROM stages WHERE name = '성수역 6번출구' AND created_by = ?", [adminUser.id]);
    if (!defaultStage) {
      const stageId = uuidv4();
      const inviteCode = Math.random().toString(36).substring(2, 10).toUpperCase();
      db.run("INSERT INTO stages (id, name, description, created_by, invite_code) VALUES (?, ?, ?, ?, ?)",
        [stageId, '성수역 6번출구', '어썸 성수점 밴드', adminUser.id, inviteCode]);
      db.run("INSERT INTO stage_members (stage_id, user_id, role) VALUES (?, ?, 'admin')",
        [stageId, adminUser.id]);
      defaultStage = { id: stageId };
      console.log('  → "성수역 6번출구" Stage 자동 생성');
    }
    // 이관 실행
    db.run("UPDATE songs SET stage_id = ? WHERE stage_id IS NULL", [defaultStage.id]);
    saveDb();
    console.log(`  ✅ ${orphanSongs.length}개 곡 → "성수역 6번출구" 이관 완료`);
  }
}

// ── Auth Middleware ──
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '로그인이 필요합니다' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: '토큰이 만료되었습니다. 다시 로그인하세요.' });
  }
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    } catch (e) { /* ignore */ }
  }
  next();
}

// ── Auth API Routes ──

// 회원가입
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, nickname } = req.body;
    if (!email || !password || !nickname) {
      return res.status(400).json({ error: '이메일, 비밀번호, 닉네임을 모두 입력하세요' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다' });
    }
    const existing = get('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      return res.status(409).json({ error: '이미 가입된 이메일입니다' });
    }
    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);
    const role = (email.toLowerCase() === ADMIN_EMAIL) ? 'admin' : 'user';
    run('INSERT INTO users (id, email, password_hash, nickname, role) VALUES (?,?,?,?,?)',
      [id, email, passwordHash, nickname, role]);
    const token = jwt.sign({ id, email, nickname, role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    run('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?', [id]);
    res.json({ token, user: { id, email, nickname, role } });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: '회원가입 처리 중 오류가 발생했습니다' });
  }
});

// 로그인
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: '이메일과 비밀번호를 입력하세요' });
    }
    const user = get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다' });
    }
    const token = jwt.sign(
      { id: user.id, email: user.email, nickname: user.nickname, role: user.role || 'user' },
      JWT_SECRET, { expiresIn: JWT_EXPIRES }
    );
    run('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?', [user.id]);
    res.json({ token, user: { id: user.id, email: user.email, nickname: user.nickname, profile_image: user.profile_image, role: user.role || 'user' } });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: '로그인 처리 중 오류가 발생했습니다' });
  }
});

// 내 프로필
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = get('SELECT id, email, nickname, profile_image, role, created_at, last_login FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다' });
  res.json(user);
});

// 프로필 수정
app.put('/api/auth/me', authMiddleware, (req, res) => {
  const { nickname } = req.body;
  if (nickname) run('UPDATE users SET nickname = ? WHERE id = ?', [nickname, req.user.id]);
  const user = get('SELECT id, email, nickname, profile_image, role FROM users WHERE id = ?', [req.user.id]);
  res.json(user);
});

// 비밀번호 변경
app.put('/api/auth/password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: '현재 비밀번호와 새 비밀번호를 모두 입력하세요' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '새 비밀번호는 6자 이상이어야 합니다' });
    }
    const user = get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다' });
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: '현재 비밀번호가 올바르지 않습니다' });
    const hash = await bcrypt.hash(newPassword, 10);
    run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
    res.json({ message: '비밀번호가 변경되었습니다' });
  } catch (e) {
    console.error('Password change error:', e);
    res.status(500).json({ error: '비밀번호 변경 중 오류가 발생했습니다' });
  }
});

// ── 비밀번호 찾기: 이메일로 재설정 링크 발송 ──
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';

// 개발/실서버 자동 감지
const IS_PROD = process.env.NODE_ENV === 'production';
const APP_URL = IS_PROD
  ? (process.env.PROD_URL || 'https://your-domain.com')
  : `http://localhost:${process.env.PORT || 3001}`;
console.log(`🌐 APP_URL: ${APP_URL} (${IS_PROD ? 'production' : 'development'})`);

function createMailTransporter() {
  if (!EMAIL_USER || !EMAIL_PASS) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
  });
}

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: '이메일을 입력하세요' });

    // 이메일 존재 여부와 무관하게 항상 성공 응답 (보안: 이메일 존재 여부 노출 방지)
    const user = get('SELECT id, nickname FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.json({ message: '입력하신 이메일로 재설정 링크를 발송했습니다.' });
    }

    // 기존 토큰 무효화
    run('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0', [user.id]);

    // 새 토큰 생성 (1시간 유효)
    const token = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    run('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?,?,?)', [user.id, token, expiresAt]);

    const resetUrl = `${APP_URL}/reset-password?token=${token}`;
    console.log(`🔑 비밀번호 재설정 링크 (${email}): ${resetUrl}`);

    const transporter = createMailTransporter();
    if (transporter) {
      await transporter.sendMail({
        from: `"Backstage" <${EMAIL_USER}>`,
        to: email,
        subject: '[Backstage] 비밀번호 재설정 안내',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0d0d0d;color:#f0ece6;border-radius:12px">
            <div style="display:flex;align-items:center;gap:10px;margin:0 0 20px">
              <img src="${APP_URL}/favicon.svg" alt="Backstage" width="36" height="36" style="border-radius:8px;display:block">
              <span style="font-size:1.5rem;font-weight:900;background:linear-gradient(135deg,#f43f5e,#fbbf24);-webkit-background-clip:text;-webkit-text-fill-color:transparent">Backstage</span>
            </div>
            <h3 style="margin:0 0 24px;color:#f0ece6">비밀번호 재설정</h3>
            <p style="color:#a1a1aa;margin:0 0 24px">안녕하세요, <strong style="color:#f0ece6">${user.nickname}</strong>님!<br>비밀번호 재설정 요청을 받았습니다.</p>
            <a href="${resetUrl}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#f43f5e,#fbbf24);color:#000;font-weight:800;text-decoration:none;border-radius:8px;font-size:1rem">비밀번호 재설정하기</a>
            <p style="color:#71717a;font-size:0.82rem;margin:24px 0 0">링크는 <strong>1시간</strong> 후 만료됩니다.<br>본인이 요청하지 않았다면 이 메일을 무시하세요.</p>
          </div>
        `
      });
    }

    res.json({ message: '입력하신 이메일로 재설정 링크를 발송했습니다.' });
  } catch (e) {
    console.error('Forgot password error:', e);
    res.status(500).json({ error: '처리 중 오류가 발생했습니다' });
  }
});

// 토큰 유효성 검증
app.get('/api/auth/reset-password/:token', (req, res) => {
  const { token } = req.params;
  const record = get(
    `SELECT prt.user_id, u.email, u.nickname FROM password_reset_tokens prt
     JOIN users u ON u.id = prt.user_id
     WHERE prt.token = ? AND prt.used = 0 AND prt.expires_at > datetime('now')`,
    [token]
  );
  if (!record) return res.status(400).json({ error: '링크가 만료되었거나 유효하지 않습니다' });
  res.json({ email: record.email, nickname: record.nickname });
});

// 비밀번호 재설정 실행
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: '요청이 올바르지 않습니다' });
    if (newPassword.length < 6) return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다' });

    const record = get(
      `SELECT user_id FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime('now')`,
      [token]
    );
    if (!record) return res.status(400).json({ error: '링크가 만료되었거나 유효하지 않습니다' });

    const hash = await bcrypt.hash(newPassword, 10);
    run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, record.user_id]);
    run('UPDATE password_reset_tokens SET used = 1 WHERE token = ?', [token]);

    res.json({ message: '비밀번호가 성공적으로 변경되었습니다' });
  } catch (e) {
    console.error('Reset password error:', e);
    res.status(500).json({ error: '처리 중 오류가 발생했습니다' });
  }
});

// ── Stage API Routes ──

// 내 Stage 목록
app.get('/api/stages', authMiddleware, (req, res) => {
  const stages = query(`
    SELECT s.*, sm.role as my_role,
    (SELECT COUNT(*) FROM stage_members WHERE stage_id = s.id) as member_count,
    (SELECT COUNT(*) FROM songs WHERE stage_id = s.id) as song_count
    FROM stages s
    JOIN stage_members sm ON s.id = sm.stage_id AND sm.user_id = ?
    ORDER BY s.created_at DESC
  `, [req.user.id]);
  res.json(stages);
});

// Stage 만들기
app.post('/api/stages', authMiddleware, (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Stage 이름을 입력하세요' });
  const id = uuidv4();
  const inviteCode = uuidv4().slice(0, 8);
  run('INSERT INTO stages (id, name, description, created_by, invite_code) VALUES (?,?,?,?,?)',
    [id, name.trim(), description || '', req.user.id, inviteCode]);
  run('INSERT INTO stage_members (stage_id, user_id, role) VALUES (?,?,?)',
    [id, req.user.id, 'admin']);
  const stage = get('SELECT * FROM stages WHERE id = ?', [id]);
  res.json({ ...stage, my_role: 'admin', member_count: 1, song_count: 0 });
});

// Stage 상세
app.get('/api/stages/:id', authMiddleware, (req, res) => {
  const membership = get('SELECT role FROM stage_members WHERE stage_id = ? AND user_id = ?',
    [req.params.id, req.user.id]);
  if (!membership) return res.status(403).json({ error: '이 Stage의 멤버가 아닙니다' });
  const stage = get('SELECT * FROM stages WHERE id = ?', [req.params.id]);
  if (!stage) return res.status(404).json({ error: 'Stage를 찾을 수 없습니다' });
  const members = query(`
    SELECT u.id, u.nickname, u.email, u.profile_image, sm.role, sm.joined_at
    FROM stage_members sm JOIN users u ON sm.user_id = u.id
    WHERE sm.stage_id = ? ORDER BY sm.joined_at ASC
  `, [req.params.id]);
  const songs = query('SELECT * FROM songs WHERE stage_id = ? ORDER BY sort_order ASC, created_at DESC',
    [req.params.id]);
  songs.forEach(s => {
    const r = get('SELECT COUNT(*) as c FROM parts WHERE song_id = ?', [s.id]);
    s.partCount = r ? r.c : 0;
  });
  res.json({ ...stage, my_role: membership.role, members, songs });
});

// Stage 초대코드 조회
app.get('/api/stages/:id/invite', authMiddleware, (req, res) => {
  const membership = get('SELECT role FROM stage_members WHERE stage_id = ? AND user_id = ?',
    [req.params.id, req.user.id]);
  if (!membership || membership.role === 'viewer') return res.status(403).json({ error: '초대 권한이 없습니다' });
  const stage = get('SELECT invite_code FROM stages WHERE id = ?', [req.params.id]);
  res.json({ invite_code: stage.invite_code });
});

// 초대코드로 Stage 참가
app.post('/api/stages/join', authMiddleware, (req, res) => {
  const { invite_code } = req.body;
  if (!invite_code) return res.status(400).json({ error: '초대 코드를 입력하세요' });
  const stage = get('SELECT * FROM stages WHERE invite_code = ?', [invite_code]);
  if (!stage) return res.status(404).json({ error: '유효하지 않은 초대 코드입니다' });
  const existing = get('SELECT id FROM stage_members WHERE stage_id = ? AND user_id = ?',
    [stage.id, req.user.id]);
  if (existing) return res.status(409).json({ error: '이미 이 Stage의 멤버입니다' });
  run('INSERT INTO stage_members (stage_id, user_id, role) VALUES (?,?,?)',
    [stage.id, req.user.id, 'editor']);
  res.json({ message: `${stage.name} Stage에 참가했습니다!`, stage_id: stage.id });
});

// Stage 설정 편집 (admin만)
app.put('/api/stages/:id', authMiddleware, (req, res) => {
  const membership = get('SELECT role FROM stage_members WHERE stage_id = ? AND user_id = ?',
    [req.params.id, req.user.id]);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: '권한이 없습니다' });
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Stage 이름을 입력하세요' });
  run('UPDATE stages SET name = ?, description = ? WHERE id = ?',
    [name.trim(), (description || '').trim(), req.params.id]);
  const stage = get('SELECT * FROM stages WHERE id = ?', [req.params.id]);
  res.json(stage);
});

// Stage 멤버 역할 변경 (admin만)
app.put('/api/stages/:id/members/:userId', authMiddleware, (req, res) => {
  const membership = get('SELECT role FROM stage_members WHERE stage_id = ? AND user_id = ?',
    [req.params.id, req.user.id]);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: '권한이 없습니다' });
  const { role } = req.body;
  if (!['admin', 'editor', 'viewer'].includes(role)) return res.status(400).json({ error: '잘못된 역할입니다' });
  run('UPDATE stage_members SET role = ? WHERE stage_id = ? AND user_id = ?',
    [role, req.params.id, req.params.userId]);
  res.json({ message: '역할이 변경되었습니다' });
});

// Stage 멤버 강퇴 (admin만)
app.delete('/api/stages/:id/members/:userId', authMiddleware, (req, res) => {
  const membership = get('SELECT role FROM stage_members WHERE stage_id = ? AND user_id = ?',
    [req.params.id, req.user.id]);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: '권한이 없습니다' });
  if (req.params.userId === req.user.id) return res.status(400).json({ error: '자기 자신을 강퇴할 수 없습니다' });
  run('DELETE FROM stage_members WHERE stage_id = ? AND user_id = ?',
    [req.params.id, req.params.userId]);
  res.json({ message: '멤버가 강퇴되었습니다' });
});

// Stage 탈퇴
app.post('/api/stages/:id/leave', authMiddleware, (req, res) => {
  const membership = get('SELECT role FROM stage_members WHERE stage_id = ? AND user_id = ?',
    [req.params.id, req.user.id]);
  if (!membership) return res.status(404).json({ error: '이 Stage의 멤버가 아닙니다' });
  if (membership.role === 'admin') {
    const adminCount = get('SELECT COUNT(*) as c FROM stage_members WHERE stage_id = ? AND role = ?',
      [req.params.id, 'admin']);
    if (adminCount.c <= 1) return res.status(400).json({ error: '마지막 관리자는 탈퇴할 수 없습니다. 다른 멤버에게 관리자를 넘겨주세요.' });
  }
  run('DELETE FROM stage_members WHERE stage_id = ? AND user_id = ?',
    [req.params.id, req.user.id]);
  res.json({ message: 'Stage를 탈퇴했습니다' });
});

// ── API Routes ──

// ── Stage 채팅 API ──
app.get('/api/stages/:stageId/messages', authMiddleware, (req, res) => {
  const { stageId } = req.params;
  const before = req.query.before; // 페이징용
  let msgs;
  if (before) {
    msgs = query(`SELECT m.id, m.message, m.created_at, m.user_id, u.nickname, u.email
      FROM stage_messages m LEFT JOIN users u ON m.user_id = u.id
      WHERE m.stage_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT 50`, [stageId, before]);
  } else {
    msgs = query(`SELECT m.id, m.message, m.created_at, m.user_id, u.nickname, u.email
      FROM stage_messages m LEFT JOIN users u ON m.user_id = u.id
      WHERE m.stage_id = ? ORDER BY m.id DESC LIMIT 50`, [stageId]);
  }
  res.json(msgs.reverse());
});

app.post('/api/stages/:stageId/messages', authMiddleware, (req, res) => {
  const { stageId } = req.params;
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: '메시지를 입력하세요' });
  const membership = get('SELECT role FROM stage_members WHERE stage_id = ? AND user_id = ?', [stageId, req.user.id]);
  if (!membership) return res.status(403).json({ error: '이 Stage의 멤버가 아닙니다' });
  run('INSERT INTO stage_messages (stage_id, user_id, message) VALUES (?,?,?)',
    [stageId, req.user.id, message.trim()]);
  saveDb();
  const msg = get(`SELECT m.id, m.message, m.created_at, m.user_id, u.nickname, u.email
    FROM stage_messages m LEFT JOIN users u ON m.user_id = u.id
    WHERE m.stage_id = ? AND m.user_id = ? ORDER BY m.id DESC LIMIT 1`, [stageId, req.user.id]);
  // Socket.IO로 실시간 전송
  if (msg) {
    io.to('stage_' + stageId).emit('stage-message', msg);
  }
  res.json(msg);
});

// ── DM API ──
// 내 DM 대화 목록
app.get('/api/dm/conversations', authMiddleware, (req, res) => {
  const conversations = query(`
    SELECT u.id as user_id, u.nickname, u.email,
      (SELECT message FROM direct_messages WHERE (sender_id = ? AND receiver_id = u.id) OR (sender_id = u.id AND receiver_id = ?) ORDER BY id DESC LIMIT 1) as last_message,
      (SELECT created_at FROM direct_messages WHERE (sender_id = ? AND receiver_id = u.id) OR (sender_id = u.id AND receiver_id = ?) ORDER BY id DESC LIMIT 1) as last_at,
      (SELECT COUNT(*) FROM direct_messages WHERE sender_id = u.id AND receiver_id = ? AND is_read = 0) as unread
    FROM users u
    WHERE u.id != ? AND (
      u.id IN (SELECT sender_id FROM direct_messages WHERE receiver_id = ?)
      OR u.id IN (SELECT receiver_id FROM direct_messages WHERE sender_id = ?)
    )
    ORDER BY last_at DESC
  `, [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]);
  res.json(conversations);
});

// 특정 유저와의 DM 메시지
app.get('/api/dm/:userId', authMiddleware, (req, res) => {
  const msgs = query(`SELECT d.*, u.nickname, u.email FROM direct_messages d
    LEFT JOIN users u ON d.sender_id = u.id
    WHERE (d.sender_id = ? AND d.receiver_id = ?) OR (d.sender_id = ? AND d.receiver_id = ?)
    ORDER BY d.id DESC LIMIT 50`,
    [req.user.id, req.params.userId, req.params.userId, req.user.id]);
  // 읽음 처리
  run('UPDATE direct_messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0',
    [req.params.userId, req.user.id]);
  saveDb();
  res.json(msgs.reverse());
});

// DM 전송
app.post('/api/dm/:userId', authMiddleware, (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: '메시지를 입력하세요' });
    run('INSERT INTO direct_messages (sender_id, receiver_id, message) VALUES (?,?,?)', 
      [req.user.id, req.params.userId, message.trim()]);
    const msg = get(`SELECT d.*, u.nickname, u.email FROM direct_messages d
      LEFT JOIN users u ON d.sender_id = u.id
      WHERE d.sender_id = ? AND d.receiver_id = ? ORDER BY d.id DESC LIMIT 1`,
      [req.user.id, req.params.userId]);
    io.to('dm_' + req.params.userId).emit('dm-message', msg);
    io.to('dm_' + req.user.id).emit('dm-message', msg);
    res.json(msg);
  } catch(e) {
    console.error('DM 전송 오류:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin API (chuli8944@gmail.com 전용) ──
function adminMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: '로그인이 필요합니다' });
  try {
    const decoded = require('jsonwebtoken').verify(authHeader.split(' ')[1], JWT_SECRET);
    if (decoded.email !== ADMIN_EMAIL && decoded.role !== 'admin') {
      return res.status(403).json({ error: '관리자만 접근 가능합니다' });
    }
    req.user = decoded;
    next();
  } catch(e) { return res.status(401).json({ error: '토큰이 만료되었습니다' }); }
}

// 전체 통계
app.get('/api/admin/stats', adminMiddleware, (req, res) => {
  const userCount = get('SELECT COUNT(*) as c FROM users').c;
  const stageCount = get('SELECT COUNT(*) as c FROM stages').c;
  const songCount = get('SELECT COUNT(*) as c FROM songs').c;
  const partCount = get('SELECT COUNT(*) as c FROM parts').c;
  const msgCount = get('SELECT COUNT(*) as c FROM stage_messages').c;
  const dmCount = get('SELECT COUNT(*) as c FROM direct_messages').c;
  const recentUsers = query('SELECT id, email, nickname, role, created_at, last_login FROM users ORDER BY created_at DESC LIMIT 5');
  res.json({ userCount, stageCount, songCount, partCount, msgCount, dmCount, recentUsers });
});

// 전체 회원 목록
app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const users = query(`
    SELECT u.id, u.email, u.nickname, u.role, u.created_at, u.last_login,
      (SELECT COUNT(*) FROM stage_members WHERE user_id = u.id) as stage_count
    FROM users u ORDER BY u.created_at DESC
  `);
  res.json(users);
});

// 회원 역할 변경
app.put('/api/admin/users/:id/role', adminMiddleware, (req, res) => {
  const { role } = req.body;
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: '잘못된 역할입니다' });
  run('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
  res.json({ ok: true });
});

// 회원 삭제
app.delete('/api/admin/users/:id', adminMiddleware, (req, res) => {
  const user = get('SELECT email FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다' });
  if (user.email === ADMIN_EMAIL) return res.status(403).json({ error: '관리자 계정은 삭제할 수 없습니다' });
  run('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// 전체 Stage 목록
app.get('/api/admin/stages', adminMiddleware, (req, res) => {
  const stages = query(`
    SELECT s.*, u.email as creator_email, u.nickname as creator_nickname,
      (SELECT COUNT(*) FROM stage_members WHERE stage_id = s.id) as member_count,
      (SELECT COUNT(*) FROM songs WHERE stage_id = s.id) as song_count,
      (SELECT COUNT(*) FROM stage_messages WHERE stage_id = s.id) as msg_count
    FROM stages s LEFT JOIN users u ON s.created_by = u.id
    ORDER BY s.created_at DESC
  `);
  res.json(stages);
});

// Stage 삭제
app.delete('/api/admin/stages/:id', adminMiddleware, (req, res) => {
  run('DELETE FROM stages WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// 전체 곡 목록 (어드민용, 파일 크기 포함)
app.get('/api/admin/songs', adminMiddleware, (req, res) => {
  const songs = query(`
    SELECT s.*, st.name as stage_name, u.nickname as creator_nickname,
      (SELECT COUNT(*) FROM parts WHERE song_id = s.id) as part_count
    FROM songs s
    LEFT JOIN stages st ON s.stage_id = st.id
    LEFT JOIN users u ON (SELECT created_by FROM stages WHERE id = s.stage_id) = u.id
    ORDER BY s.created_at DESC
  `);
  // 각 곡의 파일 크기 계산
  songs.forEach(s => {
    const parts = query('SELECT pdf_filename FROM parts WHERE song_id = ?', [s.id]);
    let totalSize = 0;
    parts.forEach(p => {
      try {
        const fp = require('path').join(uploadsDir, p.pdf_filename);
        if (fs.existsSync(fp)) totalSize += fs.statSync(fp).size;
      } catch(e) {}
    });
    if (s.cover_filename) {
      try {
        const fp = require('path').join(uploadsDir, s.cover_filename);
        if (fs.existsSync(fp)) totalSize += fs.statSync(fp).size;
      } catch(e) {}
    }
    s.total_size = totalSize;
  });
  res.json(songs);
});

// 곡 삭제 (어드민용)
app.delete('/api/admin/songs/:id', adminMiddleware, (req, res) => {
  const song = get('SELECT * FROM songs WHERE id = ?', [req.params.id]);
  if (!song) return res.status(404).json({ error: '곡을 찾을 수 없습니다' });
  // 관련 파일 삭제
  const parts = query('SELECT pdf_filename FROM parts WHERE song_id = ?', [req.params.id]);
  parts.forEach(p => {
    try { fs.unlinkSync(require('path').join(uploadsDir, p.pdf_filename)); } catch(e) {}
  });
  if (song.cover_filename) {
    try { fs.unlinkSync(require('path').join(uploadsDir, song.cover_filename)); } catch(e) {}
  }
  run('DELETE FROM songs WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ── Admin 편집 API ──

// 회원 정보 수정 (닉네임, 이메일, 역할, 비밀번호)
app.put('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  const { nickname, email, role, password } = req.body;
  const user = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다' });
  // 이메일 중복 체크 (자신 제외)
  if (email && email !== user.email) {
    const dup = get('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.params.id]);
    if (dup) return res.status(409).json({ error: '이미 사용 중인 이메일입니다' });
  }
  if (nickname) run('UPDATE users SET nickname = ? WHERE id = ?', [nickname.trim(), req.params.id]);
  if (email) run('UPDATE users SET email = ? WHERE id = ?', [email.trim().toLowerCase(), req.params.id]);
  if (role && ['admin', 'user'].includes(role)) run('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
  if (password && password.length >= 6) {
    const hash = await require('bcrypt').hash(password, 10);
    run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
  }
  saveDb();
  const updated = get('SELECT id, email, nickname, role, created_at, last_login FROM users WHERE id = ?', [req.params.id]);
  res.json(updated);
});

// Stage 정보 수정 (이름, 설명, 초대코드 재발급)
app.put('/api/admin/stages/:id', adminMiddleware, (req, res) => {
  const { name, description, regenerateInvite } = req.body;
  const stage = get('SELECT * FROM stages WHERE id = ?', [req.params.id]);
  if (!stage) return res.status(404).json({ error: 'Stage를 찾을 수 없습니다' });
  if (name) run('UPDATE stages SET name = ? WHERE id = ?', [name.trim(), req.params.id]);
  if (description !== undefined) run('UPDATE stages SET description = ? WHERE id = ?', [(description||'').trim(), req.params.id]);
  if (regenerateInvite) {
    const newCode = require('crypto').randomBytes(4).toString('hex').toUpperCase();
    run('UPDATE stages SET invite_code = ? WHERE id = ?', [newCode, req.params.id]);
  }
  saveDb();
  const updated = get('SELECT * FROM stages WHERE id = ?', [req.params.id]);
  res.json(updated);
});

// 곡 정보 수정 (이름, BPM, 박자, 키)
app.put('/api/admin/songs/:id', adminMiddleware, (req, res) => {
  const { name, bpm, time_signature } = req.body;
  const song = get('SELECT * FROM songs WHERE id = ?', [req.params.id]);
  if (!song) return res.status(404).json({ error: '곡을 찾을 수 없습니다' });
  if (name) run('UPDATE songs SET name = ? WHERE id = ?', [name.trim(), req.params.id]);
  if (bpm) run('UPDATE songs SET bpm = ? WHERE id = ?', [parseInt(bpm), req.params.id]);
  if (time_signature) run('UPDATE songs SET time_signature = ? WHERE id = ?', [time_signature, req.params.id]);
  saveDb();
  const updated = get('SELECT * FROM songs WHERE id = ?', [req.params.id]);
  res.json(updated);
});

// 곡 수정 권한 체크 헬퍼 (editor 이상만 허용)
function checkSongEditPermission(req, res, songOrStageId, isStageId = false) {
  const userId = req.user ? req.user.id : null;
  if (!userId) { res.status(401).json({ error: '로그인이 필요합니다' }); return false; }
  let stageId = isStageId ? songOrStageId : null;
  if (!isStageId) {
    const song = get('SELECT stage_id FROM songs WHERE id = ?', [songOrStageId]);
    if (!song) { res.status(404).json({ error: '곡을 찾을 수 없습니다' }); return false; }
    stageId = song.stage_id;
  }
  if (!stageId) return true; // stage 없는 곡은 허용
  const membership = get('SELECT role FROM stage_members WHERE stage_id = ? AND user_id = ?', [stageId, userId]);
  if (!membership) { res.status(403).json({ error: '이 Stage의 멤버가 아닙니다' }); return false; }
  if (membership.role === 'viewer') { res.status(403).json({ error: '편집 권한이 없습니다 (viewer)' }); return false; }
  return true;
}

app.get('/api/songs', (req, res) => {
  const stageId = req.query.stage_id;
  let songs;
  if (stageId) {
    songs = query('SELECT * FROM songs WHERE stage_id = ? ORDER BY sort_order ASC, created_at DESC', [stageId]);
  } else {
    songs = query('SELECT * FROM songs ORDER BY sort_order ASC, created_at DESC');
  }
  songs.forEach(s => {
    const r = get('SELECT COUNT(*) as c FROM parts WHERE song_id = ?', [s.id]);
    s.partCount = r ? r.c : 0;
  });
  res.json(songs);
});

app.put('/api/songs/reorder', (req, res) => {
  const { order } = req.body; // [{id, sort_order}]
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order required' });
  order.forEach(o => run('UPDATE songs SET sort_order = ? WHERE id = ?', [o.sort_order, o.id]));
  res.json({ ok: true });
});

app.post('/api/songs', authMiddleware, (req, res) => {
  const { name, bpm, time_signature, count_in_bars, stage_id } = req.body;
  if (stage_id && !checkSongEditPermission(req, res, stage_id, true)) return;
  const id = uuidv4();
  run('INSERT INTO songs (id,name,bpm,time_signature,count_in_bars,stage_id) VALUES (?,?,?,?,?,?)',
    [id, name || '새 곡', bpm || 120, time_signature || '4/4', count_in_bars || 2, stage_id || null]);
  res.json(get('SELECT * FROM songs WHERE id = ?', [id]));
});

app.get('/api/songs/:id', (req, res) => {
  const song = get('SELECT * FROM songs WHERE id = ?', [req.params.id]);
  if (!song) return res.status(404).json({ error: 'Not found' });
  song.parts = query('SELECT * FROM parts WHERE song_id = ?', [req.params.id]);
  song.parts.forEach(p => {
    p.pages = query('SELECT * FROM page_info WHERE part_id = ? ORDER BY page_number', [p.id]);
    p.systems = query('SELECT * FROM staff_systems WHERE part_id = ? ORDER BY page_number, system_index', [p.id]);
    p.playbackOrder = query('SELECT * FROM part_playback_order WHERE part_id = ? ORDER BY order_index', [p.id]);
  });
  song.sections = query('SELECT * FROM sections WHERE song_id = ? ORDER BY order_index', [req.params.id]);
  song.flow = query('SELECT * FROM song_flow WHERE song_id = ? ORDER BY order_index', [req.params.id]);
  res.json(song);
});

app.put('/api/songs/:id', authMiddleware, (req, res) => {
  const song = get('SELECT * FROM songs WHERE id = ?', [req.params.id]);
  if (!song) return res.status(404).json({ error: 'Not found' });
  if (!checkSongEditPermission(req, res, req.params.id)) return;
  const { name, bpm, time_signature, count_in_bars, inst_delay_ms } = req.body;
  run('UPDATE songs SET name=?, bpm=?, time_signature=?, count_in_bars=?, inst_delay_ms=? WHERE id=?',
    [name ?? song.name, bpm ?? song.bpm, time_signature ?? song.time_signature,
     count_in_bars ?? song.count_in_bars, inst_delay_ms ?? song.inst_delay_ms ?? 0, req.params.id]);
  if (bpm && bpm !== song.bpm) io.to(req.params.id).emit('tempo-changed', { bpm });
  res.json(get('SELECT * FROM songs WHERE id = ?', [req.params.id]));
});

// Cover image upload
app.post('/api/songs/:id/cover', authMiddleware, uploadAny.single('cover'), (req, res) => {
  if (!checkSongEditPermission(req, res, req.params.id)) return;
  const song = get('SELECT * FROM songs WHERE id = ?', [req.params.id]);
  if (!song) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  // Delete old cover
  if (song.cover_filename) {
    const old = path.join(uploadsDir, song.cover_filename);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  run('UPDATE songs SET cover_filename=? WHERE id=?', [req.file.filename, req.params.id]);
  res.json({ cover_filename: req.file.filename });
});

// Inst audio upload
app.post('/api/songs/:id/inst', authMiddleware, uploadAny.single('inst'), (req, res) => {
  if (!checkSongEditPermission(req, res, req.params.id)) return;
  const song = get('SELECT * FROM songs WHERE id = ?', [req.params.id]);
  if (!song) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  if (song.inst_filename) {
    const old = path.join(uploadsDir, song.inst_filename);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  run('UPDATE songs SET inst_filename=? WHERE id=?', [req.file.filename, req.params.id]);
  res.json({ inst_filename: req.file.filename });
});

app.delete('/api/songs/:id', authMiddleware, (req, res) => {
  if (!checkSongEditPermission(req, res, req.params.id)) return;
  const parts = query('SELECT pdf_filename FROM parts WHERE song_id = ?', [req.params.id]);
  parts.forEach(p => {
    const fp = path.join(uploadsDir, p.pdf_filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
  run('DELETE FROM page_info WHERE part_id IN (SELECT id FROM parts WHERE song_id = ?)', [req.params.id]);
  run('DELETE FROM parts WHERE song_id = ?', [req.params.id]);
  run('DELETE FROM sections WHERE song_id = ?', [req.params.id]);
  run('DELETE FROM song_flow WHERE song_id = ?', [req.params.id]);
  run('DELETE FROM songs WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// Parts
app.post('/api/songs/:songId/parts', authMiddleware, upload.single('pdf'), (req, res) => {
  if (!checkSongEditPermission(req, res, req.params.songId)) return;
  if (!req.file) return res.status(400).json({ error: 'PDF 파일이 필요합니다' });
  const id = uuidv4();
  const totalPages = parseInt(req.body.totalPages) || 1;
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  run('INSERT INTO parts (id,song_id,name,pdf_filename,original_filename,total_pages) VALUES (?,?,?,?,?,?)',
    [id, req.params.songId, req.body.name || '파트', req.file.filename, originalName, totalPages]);
  for (let i = 1; i <= totalPages; i++) {
    run('INSERT INTO page_info (part_id,page_number,measures) VALUES (?,?,?)', [id, i, 4]);
  }
  const part = get('SELECT * FROM parts WHERE id = ?', [id]);
  part.pages = query('SELECT * FROM page_info WHERE part_id = ? ORDER BY page_number', [id]);
  res.json(part);
});

app.delete('/api/parts/:id', authMiddleware, (req, res) => {
  const part = get('SELECT pdf_filename FROM parts WHERE id = ?', [req.params.id]);
  if (part) {
    const fp = path.join(uploadsDir, part.pdf_filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  run('DELETE FROM page_info WHERE part_id = ?', [req.params.id]);
  run('DELETE FROM staff_systems WHERE part_id = ?', [req.params.id]);
  run('DELETE FROM part_playback_order WHERE part_id = ?', [req.params.id]);
  run('DELETE FROM parts WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// Staff Systems
app.put('/api/parts/:partId/systems', (req, res) => {
  const { systems } = req.body;
  run('DELETE FROM staff_systems WHERE part_id = ?', [req.params.partId]);
  (systems || []).forEach(s => {
    run('INSERT INTO staff_systems (part_id,page_number,system_index,top_pct,bottom_pct,measures,repeat_start_at,repeat_end_at,volta,volta_from,volta_to) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [req.params.partId, s.page_number, s.system_index, s.top_pct, s.bottom_pct, s.measures || 2, s.repeat_start_at || 0, s.repeat_end_at || 0, s.volta || 0, s.volta_from || 0, s.volta_to || 0]);
  });
  res.json({ success: true });
});

app.get('/api/parts/:partId/systems', (req, res) => {
  const systems = query('SELECT * FROM staff_systems WHERE part_id = ? ORDER BY page_number, system_index', [req.params.partId]);
  res.json(systems);
});

// Style Settings per Part
app.get('/api/parts/:partId/style', (req, res) => {
  const part = get('SELECT style_settings FROM parts WHERE id = ?', [req.params.partId]);
  if (!part || !part.style_settings) return res.json({});
  try { res.json(JSON.parse(part.style_settings)); } catch(e) { res.json({}); }
});

app.put('/api/parts/:partId/style', (req, res) => {
  run('UPDATE parts SET style_settings = ? WHERE id = ?', [JSON.stringify(req.body), req.params.partId]);
  res.json({ success: true });
});

// Playback Order
app.put('/api/parts/:partId/playback-order', (req, res) => {
  const { order } = req.body; // [pageNumber, pageNumber, ...]
  run('DELETE FROM part_playback_order WHERE part_id = ?', [req.params.partId]);
  (order || []).forEach((pageNum, i) => {
    run('INSERT INTO part_playback_order (part_id,order_index,page_number) VALUES (?,?,?)',
      [req.params.partId, i, pageNum]);
  });
  res.json({ success: true });
});

app.get('/api/parts/:partId/playback-order', (req, res) => {
  const order = query('SELECT * FROM part_playback_order WHERE part_id = ? ORDER BY order_index', [req.params.partId]);
  res.json(order);
});

app.put('/api/parts/:partId/pages', (req, res) => {
  const { pages } = req.body;
  pages.forEach(p => {
    run('INSERT OR REPLACE INTO page_info (part_id,page_number,measures) VALUES (?,?,?)',
      [req.params.partId, p.page_number, p.measures]);
  });
  res.json({ success: true });
});

// Sections & Flow
app.put('/api/songs/:songId/sections', (req, res) => {
  run('DELETE FROM sections WHERE song_id = ?', [req.params.songId]);
  (req.body.sections || []).forEach((s, i) => {
    run('INSERT INTO sections (song_id,name,start_measure,end_measure,order_index) VALUES (?,?,?,?,?)',
      [req.params.songId, s.name, s.start_measure, s.end_measure, i]);
  });
  res.json({ success: true });
});

app.put('/api/songs/:songId/flow', (req, res) => {
  run('DELETE FROM song_flow WHERE song_id = ?', [req.params.songId]);
  (req.body.flow || []).forEach((name, i) => {
    run('INSERT INTO song_flow (song_id,section_name,order_index) VALUES (?,?,?)',
      [req.params.songId, name, i]);
  });
  res.json({ success: true });
});

// ── Socket.IO ──
const rooms = {};

function getMemberList(songId) {
  const room = io.sockets.adapter.rooms.get(songId);
  if (!room) return [];
  const members = [];
  for (const sid of room) {
    const s = io.sockets.sockets.get(sid);
  if (s) members.push({ id: sid, partName: s.partName || '?', partId: s.partId, instMuted: !!s.instMuted });
  }
  return members;
}

function broadcastMembers(songId) {
  const members = getMemberList(songId);
  io.to(songId).emit('member-list', members);
  io.to(songId).emit('member-count', members.length);
}

io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);

  // Stage 채팅방 참가
  socket.on('join-stage-chat', (stageId) => {
    if (socket.stageRoom) socket.leave(socket.stageRoom);
    socket.stageRoom = 'stage_' + stageId;
    socket.join(socket.stageRoom);
  });

  // DM 개인 룸 참가
  socket.on('join-dm', (userId) => {
    socket.join('dm_' + userId);
  });

  socket.on('join-room', ({ songId, partId, partName }) => {
    socket.join(songId);
    socket.songId = songId;
    socket.partId = partId;
    socket.partName = partName || '알 수 없음';
    socket.instMuted = true; // 초기 접속 시 inst는 음소거 상태
    if (!rooms[songId]) {
      rooms[songId] = { state: 'idle', bpm: null, currentPage: 1, elapsedMs: 0, startTime: null };
    }
    // 이전 세션 잔존 상태 정리: playing/counting 상태인데 아무도 없었으면 리셋
    const r = rooms[songId];
    if (r.state === 'playing' || r.state === 'counting') {
      const memberCount = io.sockets.adapter.rooms.get(songId)?.size || 0;
      if (memberCount <= 1) { // 본인만 있으면 리셋
        r.state = 'idle'; r.elapsedMs = 0; r.startTime = null;
      }
    }
    socket.emit('room-state', rooms[songId]);
    broadcastMembers(songId);
  });

  socket.on('start', ({ bpm, countInBeats }) => {
    const r = rooms[socket.songId];
    if (!r) return;
    r.state = 'counting'; r.bpm = bpm; r.currentPage = 1; r.elapsedMs = 0;
    io.to(socket.songId).emit('count-in', { bpm, countInBeats });
  });

  socket.on('count-in-done', () => {
    const r = rooms[socket.songId];
    if (!r) return;
    r.state = 'playing'; r.startTime = Date.now();
    io.to(socket.songId).emit('play');
  });

  socket.on('stop', () => {
    const r = rooms[socket.songId];
    if (!r) return;
    r.state = 'idle'; r.currentPage = 1; r.elapsedMs = 0; r.startTime = null;
    io.to(socket.songId).emit('stopped');
  });

  socket.on('pause', () => {
    const r = rooms[socket.songId];
    if (!r || r.state !== 'playing') return;
    r.state = 'paused'; r.elapsedMs += Date.now() - r.startTime;
    io.to(socket.songId).emit('paused', { elapsedMs: r.elapsedMs });
  });

  socket.on('resume', () => {
    const r = rooms[socket.songId];
    if (!r || r.state !== 'paused') return;
    r.state = 'playing'; r.startTime = Date.now();
    io.to(socket.songId).emit('resumed', { elapsedMs: r.elapsedMs });
  });

  socket.on('tempo-change', ({ bpm }) => {
    const r = rooms[socket.songId];
    if (!r) return;
    if (r.state === 'playing') { r.elapsedMs += Date.now() - r.startTime; r.startTime = Date.now(); }
    r.bpm = bpm;
    io.to(socket.songId).emit('tempo-changed', { bpm });
  });

  socket.on('goto-page', ({ page }) => {
    const r = rooms[socket.songId];
    if (!r) return;
    r.currentPage = page;
    io.to(socket.songId).emit('page-changed', { page });
  });

  socket.on('seek', ({ elapsedMs }) => {
    const r = rooms[socket.songId];
    if (!r) return;
    r.elapsedMs = elapsedMs;
    r.startTime = Date.now();
    if (r.state !== 'playing') { r.state = 'playing'; }
    io.to(socket.songId).emit('seeked', { elapsedMs });
  });

  socket.on('mute-inst', ({ targetId }) => {
    io.to(targetId).emit('remote-mute-inst');
  });

  socket.on('unmute-inst', ({ targetId }) => {
    io.to(targetId).emit('remote-unmute-inst');
  });

  // inst 상태 변경을 방 전체에 브로드캐스트
  socket.on('inst-state-changed', ({ muted }) => {
    socket.instMuted = !!muted;
    if (socket.songId) {
      socket.to(socket.songId).emit('inst-state-update', { memberId: socket.id, muted });
      broadcastMembers(socket.songId);
    }
  });

  socket.on('disconnect', () => {
    if (socket.songId) {
      broadcastMembers(socket.songId);
    }
  });
});

// Start
initDb().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎵 Backstage running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
