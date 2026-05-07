/**
 * ================================================================
 * DrawingManager — 악보 위 필기(드로잉) 기능
 * ================================================================
 * - PointerEvent API 기반 마우스/터치/Apple Pencil 통합 처리
 * - 펜(스타일러스) 자동 감지: 펜으로 터치하면 자동 드로잉
 * - 필압(pressure) 기반 선 굵기 자동 조절
 * - 플로팅 FAB: 접힌 ✏️ ↔ 펼친 팔레트 전환
 * - 페이지별 스트로크 데이터를 localStorage에 자동 저장
 * - 비율 좌표(0~1)로 저장하여 화면 크기 변경에도 정확히 재현
 * ================================================================
 */

// ── 드로잉 상태 ──
let drawMode = false;        // 드로잉 모드 활성화 여부
let penAutoMode = true;      // 펜 자동 감지 모드 (기본 ON)
let eraserMode = false;      // 지우개 모드
let drawColor = '#ef4444';   // 현재 펜 색상
let drawWidth = 0.8;         // 현재 펜 굵기 (기본값)
let drawingStrokes = {};     // 페이지별 스트로크 데이터
let currentStroke = null;    // 현재 그리고 있는 스트로크
let isDrawing = false;       // 드로잉 진행 중 플래그
let isPenDrawing = false;    // 펜 자동 감지로 그리는 중인지
let paletteFadeTimer = null; // 팔레트 자동 접힘 타이머

// 저장된 펜 설정 복원
try {
  const saved = JSON.parse(localStorage.getItem('drawPrefs'));
  if (saved) {
    if (saved.color) drawColor = saved.color;
    if (saved.width) drawWidth = saved.width;
  }
} catch (e) { }
// DOM 준비 후 FAB 컬러 링 반영
document.addEventListener('DOMContentLoaded', () => { updateFabColorRing(); });

/** 현재 입력이 드로잉을 해야 하는지 판단 */
function shouldDraw(e) {
  if (isPinching) return false;
  if (drawMode) return true;
  if (penAutoMode && e.pointerType === 'pen') return true;
  return false;
}

/** localStorage 키 생성 */
function drawStorageKey(pageNum) {
  return `drawing_${partId}_${pageNum}`;
}

/** 페이지별 드로잉 데이터 로드 */
function loadDrawing(pageNum) {
  if (drawingStrokes[pageNum]) return drawingStrokes[pageNum];
  try {
    const raw = localStorage.getItem(drawStorageKey(pageNum));
    drawingStrokes[pageNum] = raw ? JSON.parse(raw) : [];
  } catch (e) {
    drawingStrokes[pageNum] = [];
  }
  return drawingStrokes[pageNum];
}

/** 페이지별 드로잉 데이터 저장 */
function saveDrawing(pageNum) {
  try {
    localStorage.setItem(drawStorageKey(pageNum), JSON.stringify(drawingStrokes[pageNum] || []));
  } catch (e) { /* 용량 초과 등 무시 */ }
}

/** 드로잉 캔버스에 모든 스트로크 렌더링 */
function renderDrawing(canvasId, pageNum) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  // 유효하지 않은 페이지 번호면 캔버스를 클리어만 하고 리턴
  if (pageNum < 1 || pageNum > totalPages) {
    const dpr = window.devicePixelRatio || 1;
    const parent = canvas.parentElement;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const parent = canvas.parentElement;
  const w = parent.clientWidth;
  const h = parent.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const strokes = loadDrawing(pageNum);
  strokes.forEach(stroke => {
    if (stroke.points.length < 2) return;
    ctx.strokeStyle = stroke.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const hasPressure = stroke.points.some(p => p.pressure !== undefined && p.pressure > 0);
    const pts = stroke.points;

    if (hasPressure) {
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const cur = pts[i];
        const pressure = cur.pressure || 0.5;
        ctx.beginPath();
        ctx.lineWidth = stroke.width * (0.3 + pressure * 1.4);
        ctx.moveTo(prev.x * w, prev.y * h);
        ctx.lineTo(cur.x * w, cur.y * h);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.lineWidth = stroke.width;
      ctx.moveTo(pts[0].x * w, pts[0].y * h);
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const cur = pts[i];
        const mx = ((prev.x + cur.x) / 2) * w;
        const my = ((prev.y + cur.y) / 2) * h;
        ctx.quadraticCurveTo(prev.x * w, prev.y * h, mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x * w, last.y * h);
      ctx.stroke();
    }
  });
}

/** 드로잉 캔버스에서 좌표 추출 (비율 좌표 반환) */
function getDrawPos(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
    pressure: e.pressure || 0
  };
}

/** 드로잉 캔버스의 페이지 번호 추출 */
function getDrawPageNum(canvasId) {
  if (canvasId === 'dcS') return curDispPage;
  if (canvasId === 'dcDL') return curDispPage;
  if (canvasId === 'dcDR') return curDispPage + 1 <= totalPages ? curDispPage + 1 : -1;
  const m = canvasId.match(/dcPT(\d+)/);
  return m ? parseInt(m[1]) : curDispPage;
}

/** PointerEvent 핸들러 등록 */
function attachDrawHandlers(canvas) {
  canvas.style.pointerEvents = 'auto';
  canvas.addEventListener('pointerdown', onDrawStart, { passive: false });
  canvas.addEventListener('pointermove', onDrawMove, { passive: false });
  canvas.addEventListener('pointerup', onDrawEnd);
  canvas.addEventListener('pointerleave', onDrawEnd);
  canvas.addEventListener('pointercancel', onDrawEnd);
}

function onDrawStart(e) {
  const canDraw = shouldDraw(e);
  const isPen = e.pointerType === 'pen';

  if (!canDraw) {
    const canvas = e.currentTarget;
    canvas.style.pointerEvents = 'none';
    const below = document.elementFromPoint(e.clientX, e.clientY);
    if (below && below !== canvas) {
      below.dispatchEvent(new PointerEvent(e.type, e));
    }
    requestAnimationFrame(() => { canvas.style.pointerEvents = 'auto'; });
    return;
  }

  e.preventDefault();
  e.stopPropagation();
  const canvas = e.currentTarget;
  const pos = getDrawPos(e, canvas);
  const pageNum = getDrawPageNum(canvas.id);

  // 펜 자동 감지 시 FAB 펼침
  if (isPen && !drawMode) {
    isPenDrawing = true;
    expandDrawFab();
  }

  if (eraserMode) {
    eraseAt(pageNum, pos, canvas.id);
    return;
  }

  isDrawing = true;
  currentStroke = {
    points: [pos],
    color: drawColor,
    width: drawWidth
  };
  canvas.setPointerCapture(e.pointerId);
}

function onDrawMove(e) {
  const canDraw = shouldDraw(e);
  if (!canDraw && !isDrawing) return;

  e.preventDefault();
  e.stopPropagation();
  const canvas = e.currentTarget;
  const pos = getDrawPos(e, canvas);

  if (eraserMode && e.pressure > 0) {
    const pageNum = getDrawPageNum(canvas.id);
    eraseAt(pageNum, pos, canvas.id);
    return;
  }

  if (!isDrawing || !currentStroke) return;
  currentStroke.points.push(pos);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pts = currentStroke.points;
  if (pts.length >= 2) {
    const prev = pts[pts.length - 2];
    const cur = pts[pts.length - 1];
    const pressure = cur.pressure || 0.5;
    ctx.beginPath();
    ctx.strokeStyle = currentStroke.color;
    ctx.lineWidth = (e.pointerType === 'pen')
      ? currentStroke.width * (0.3 + pressure * 1.4)
      : currentStroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.moveTo(prev.x * w, prev.y * h);
    ctx.lineTo(cur.x * w, cur.y * h);
    ctx.stroke();
  }
}

function onDrawEnd(e) {
  // 펜 자동 감지 → 일정 시간 후 자동 접힘
  if (isPenDrawing && e.pointerType === 'pen') {
    isPenDrawing = false;
    if (!drawMode) {
      clearTimeout(paletteFadeTimer);
      paletteFadeTimer = setTimeout(() => {
        if (!isPenDrawing && !drawMode) {
          collapseDrawFab();
        }
      }, 4000);
    }
  }

  if (!isDrawing || !currentStroke) { isDrawing = false; return; }
  const canvas = e.currentTarget;
  const pageNum = getDrawPageNum(canvas.id);
  // 유효하지 않은 페이지(빈 오른쪽 페이지 등)면 저장하지 않음
  if (pageNum < 1 || pageNum > totalPages) {
    currentStroke = null;
    isDrawing = false;
    return;
  }
  if (currentStroke.points.length >= 1) {
    loadDrawing(pageNum);
    drawingStrokes[pageNum].push(currentStroke);
    saveDrawing(pageNum);
  }
  currentStroke = null;
  isDrawing = false;
  renderDrawing(canvas.id, pageNum);
}

/** 지우개: 특정 위치 근처 스트로크 제거 */
function eraseAt(pageNum, pos, canvasId) {
  const strokes = loadDrawing(pageNum);
  const threshold = 0.025;
  let changed = false;
  drawingStrokes[pageNum] = strokes.filter(stroke => {
    for (const pt of stroke.points) {
      const dx = pt.x - pos.x;
      const dy = pt.y - pos.y;
      if (Math.sqrt(dx * dx + dy * dy) < threshold) {
        changed = true;
        return false;
      }
    }
    return true;
  });
  if (changed) {
    saveDrawing(pageNum);
    renderDrawing(canvasId, pageNum);
  }
}

// ── FAB UI 제어 ──

/** FAB 펼치기 (팔레트 표시 + drawMode ON) */
function expandDrawFab() {
  drawMode = true;
  const area = document.getElementById('canvasArea');
  area.classList.add('draw-active');
  area.removeAttribute('onclick');

  // 필기 모드: 헤더/푸터 숨김 (화살표는 유지)
  document.getElementById('topBar').classList.add('hidden');
  document.getElementById('ctrlBar').classList.add('hidden');
  // 화살표는 필기모드에서 항상 표시
  document.querySelectorAll('.nav-arrow').forEach(a => a.classList.remove('hidden'));
  showView(); // 악보 영역 재계산 + updateNavArrows

  document.getElementById('fabCollapsed').style.display = 'none';
  document.getElementById('fabExpanded').style.display = 'flex';
  clearTimeout(paletteFadeTimer);
  updateFabColorRing();
  syncPaletteUI(); // 저장된 색상/굵기로 active 동기화
}

/** FAB 접기 (drawMode OFF) */
function collapseDrawFab() {
  drawMode = false;
  const area = document.getElementById('canvasArea');
  area.classList.remove('draw-active');
  area.setAttribute('onclick', 'onCanvasTap()');

  eraserMode = false;
  const btnEraser = document.getElementById('btnEraser');
  if (btnEraser) btnEraser.classList.remove('active');
  document.querySelectorAll('.draw-canvas').forEach(c => c.classList.remove('eraser-mode'));

  // 필기 모드 해제: 헤더/푸터 복원
  uiVisible = true;
  document.getElementById('topBar').classList.remove('hidden');
  document.getElementById('ctrlBar').classList.remove('hidden');
  updateNavArrows();
  showView(); // 악보 영역 재계산

  document.getElementById('fabCollapsed').style.display = 'flex';
  document.getElementById('fabExpanded').style.display = 'none';
  clearTimeout(paletteFadeTimer);
  updateFabColorRing();
}

/** 기존 toggleDrawMode (단축키 P용) */
function toggleDrawMode() {
  if (drawMode) {
    collapseDrawFab();
  } else {
    expandDrawFab();
  }
}

/** 접힌 FAB의 테두리 색상 = 현재 펜 색상 */
function updateFabColorRing() {
  const ring = document.getElementById('fabColorRing');
  if (ring) ring.style.borderColor = drawColor;
}

/** 팔레트 UI를 현재 drawColor/drawWidth에 맞게 active 동기화 */
function syncPaletteUI() {
  // 색상 active
  document.querySelectorAll('.draw-fab .dt-color').forEach(el => {
    const bg = el.style.background || el.style.backgroundColor;
    el.classList.toggle('active', bg === drawColor);
  });
  // 굵기 active
  const widthMap = { 0.8: 0, 1.5: 1, 3: 2 };
  const idx = widthMap[drawWidth] ?? -1;
  document.querySelectorAll('.draw-fab .dt-width').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
  });
}

/** 펜 색상 변경 */
function setDrawColor(color, el) {
  drawColor = color;
  document.querySelectorAll('.draw-fab .dt-color').forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
  eraserMode = false;
  const btnEraser = document.getElementById('btnEraser');
  if (btnEraser) btnEraser.classList.remove('active');
  document.querySelectorAll('.draw-canvas').forEach(c => c.classList.remove('eraser-mode'));
  updateFabColorRing();
  saveDrawPrefs();
}

/** 펜 굵기 변경 */
function setDrawWidth(w, el) {
  drawWidth = w;
  document.querySelectorAll('.draw-fab .dt-width').forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
  saveDrawPrefs();
}

/** 펜 설정 localStorage 저장 */
function saveDrawPrefs() {
  try { localStorage.setItem('drawPrefs', JSON.stringify({ color: drawColor, width: drawWidth })); } catch (e) { }
}

/** 지우개 토글 */
function toggleEraser() {
  eraserMode = !eraserMode;
  document.getElementById('btnEraser').classList.toggle('active', eraserMode);
  document.querySelectorAll('.draw-canvas').forEach(c => c.classList.toggle('eraser-mode', eraserMode));
}

/** 현재 페이지 드로잉 전체 삭제 */
function clearDrawing() {
  if (!confirm('현재 페이지의 필기를 모두 지우시겠습니까?')) return;
  const pageNum = curDispPage;
  drawingStrokes[pageNum] = [];
  saveDrawing(pageNum);
  refreshAllDrawCanvases();
}

/** 되돌리기 (Undo) */
function undoDraw() {
  const pageNum = curDispPage;
  const strokes = loadDrawing(pageNum);
  if (strokes.length === 0) return;
  strokes.pop();
  saveDrawing(pageNum);
  refreshAllDrawCanvases();
}

/** 현재 뷰의 모든 드로잉 캔버스 새로고침 */
function refreshAllDrawCanvases() {
  if (viewMode === 'single') {
    renderDrawing('dcS', curDispPage);
  } else if (viewMode === 'dual') {
    renderDrawing('dcDL', curDispPage);
    renderDrawing('dcDR', curDispPage + 1 <= totalPages ? curDispPage + 1 : -1);
  } else if (viewMode === 'portrait') {
    for (let pg = 1; pg <= totalPages; pg++) {
      renderDrawing('dcPT' + pg, pg);
    }
  }
}

/** showView 확장: 뷰 전환 시 드로잉도 함께 렌더링 */
function refreshDrawOnViewChange() {
  requestAnimationFrame(() => {
    ['dcS', 'dcDL', 'dcDR'].forEach(id => {
      const c = document.getElementById(id);
      if (c && !c._drawAttached) {
        attachDrawHandlers(c);
        c._drawAttached = true;
      }
    });
    refreshAllDrawCanvases();
  });
}

/** 플로팅 FAB 드래그 초기화 */
function initPaletteDrag() {
  const fab = document.getElementById('drawFab');
  const handle = document.getElementById('dpHandle');
  const collapsed = document.getElementById('fabCollapsed');
  if (!fab) return;

  let isDragging = false;
  let startX, startY, origX, origY;
  let moved = false;

  function startDrag(e) {
    isDragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = fab.getBoundingClientRect();
    origX = rect.left;
    origY = rect.top;
    e.preventDefault();
  }

  function moveDrag(e) {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    let newX = origX + dx;
    let newY = origY + dy;
    const pw = fab.offsetWidth;
    const ph = fab.offsetHeight;
    newX = Math.max(0, Math.min(window.innerWidth - pw, newX));
    newY = Math.max(0, Math.min(window.innerHeight - ph, newY));
    fab.style.left = newX + 'px';
    fab.style.top = newY + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
  }

  function endDrag() { isDragging = false; }

  // 핸들 드래그 (펼친 상태)
  if (handle) {
    handle.addEventListener('pointerdown', (e) => {
      startDrag(e);
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', moveDrag);
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }

  // 접힌 FAB 드래그
  if (collapsed) {
    collapsed.addEventListener('pointerdown', (e) => {
      startDrag(e);
      collapsed.setPointerCapture(e.pointerId);
    });
    collapsed.addEventListener('pointermove', moveDrag);
    collapsed.addEventListener('pointerup', (e) => {
      endDrag();
      // 드래그가 아니라 클릭이면 펼치기
      if (!moved) expandDrawFab();
    });
    collapsed.addEventListener('pointercancel', endDrag);
  }

  // 팔레트 터치 시 자동 접힘 타이머 리셋
  if (fab) {
    fab.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.fab-expanded')) {
        clearTimeout(paletteFadeTimer);
      }
    });
  }
}
