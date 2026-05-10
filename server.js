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
const cleanRoutes = ['login', 'guide', 'player', 'taskboard', 'profile', 'admin'];
cleanRoutes.forEach(name => {
  app.get(`/${name}`, (req, res) => {
    const filePath = path.join(__dirname, 'public', `${name}.html`);
    if (fs.existsSync(filePath)) res.sendFile(filePath);
    else res.status(404).send('Page not found');
  });
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
