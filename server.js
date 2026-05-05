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
  saveDb();
  // Migration: 기존 DB에 새 컬럼 추가
  try { db.run('ALTER TABLE songs ADD COLUMN cover_filename TEXT'); saveDb(); } catch(e) {}
  try { db.run('ALTER TABLE songs ADD COLUMN inst_filename TEXT'); saveDb(); } catch(e) {}
  try { db.run('ALTER TABLE parts ADD COLUMN style_settings TEXT'); saveDb(); } catch(e) {}
}

// ── API Routes ──

app.get('/api/songs', (req, res) => {
  const songs = query('SELECT * FROM songs ORDER BY sort_order ASC, created_at DESC');
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

app.post('/api/songs', (req, res) => {
  const { name, bpm, time_signature, count_in_bars } = req.body;
  const id = uuidv4();
  run('INSERT INTO songs (id,name,bpm,time_signature,count_in_bars) VALUES (?,?,?,?,?)',
    [id, name || '새 곡', bpm || 120, time_signature || '4/4', count_in_bars || 2]);
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

app.put('/api/songs/:id', (req, res) => {
  const song = get('SELECT * FROM songs WHERE id = ?', [req.params.id]);
  if (!song) return res.status(404).json({ error: 'Not found' });
  const { name, bpm, time_signature, count_in_bars } = req.body;
  run('UPDATE songs SET name=?, bpm=?, time_signature=?, count_in_bars=? WHERE id=?',
    [name ?? song.name, bpm ?? song.bpm, time_signature ?? song.time_signature,
     count_in_bars ?? song.count_in_bars, req.params.id]);
  if (bpm && bpm !== song.bpm) io.to(req.params.id).emit('tempo-changed', { bpm });
  res.json(get('SELECT * FROM songs WHERE id = ?', [req.params.id]));
});

// Cover image upload
app.post('/api/songs/:id/cover', uploadAny.single('cover'), (req, res) => {
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
app.post('/api/songs/:id/inst', uploadAny.single('inst'), (req, res) => {
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

app.delete('/api/songs/:id', (req, res) => {
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
app.post('/api/songs/:songId/parts', upload.single('pdf'), (req, res) => {
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

app.delete('/api/parts/:id', (req, res) => {
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
    console.log(`🎵 BandScore running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
