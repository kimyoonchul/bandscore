/**
 * ================================================================
 * DrawingManager — 악보 위 필기(드로잉) 기능
 * ================================================================
 * - PointerEvent API 기반 마우스/터치/Apple Pencil 통합 처리
 * - 펜(스타일러스) 자동 감지: 펜으로 터치하면 자동 드로잉
 * - 필압(pressure) 기반 선 굵기 자동 조절
 * - 페이지별 스트로크 데이터를 localStorage에 자동 저장
 * - 비율 좌표(0~1)로 저장하여 화면 크기 변경에도 정확히 재현
 * - 지우개, 되돌리기, 전체 지우기 지원
 * ================================================================
 */

// ── 드로잉 상태 ──
let drawMode = false;        // 수동 드로잉 모드 (✏️ 버튼으로 토글)
let penAutoMode = true;      // 펜 자동 감지 모드 (기본 ON)
let eraserMode = false;      // 지우개 모드
let drawColor = '#ef4444';   // 현재 펜 색상
let drawWidth = 2;           // 현재 펜 굵기 (기본값)
let drawingStrokes = {};     // 페이지별 스트로크 데이터: { pageNum: [{points, color, width}] }
let currentStroke = null;    // 현재 그리고 있는 스트로크
let isDrawing = false;       // 드로잉 진행 중 플래그
let isPenDrawing = false;    // 펜 자동 감지로 그리는 중인지

/** 현재 입력이 드로잉을 해야 하는지 판단 */
function shouldDraw(e) {
  // 핀치 줌 중이면 드로잉 금지
  if (isPinching) return false;
  // 수동 드로잉 모드가 켜져 있으면 모든 입력으로 그리기
  if (drawMode) return true;
  // 펜 자동 감지: pointerType이 'pen'이면 자동으로 그리기
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
  const dpr = window.devicePixelRatio || 1;
  // 캔버스 크기를 부모(악보 캔버스)에 맞춤
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

    // 필압 데이터가 있으면 구간별 굵기 변경 렌더링
    const hasPressure = stroke.points.some(p => p.pressure !== undefined && p.pressure > 0);
    const pts = stroke.points;

    if (hasPressure) {
      // 필압 기반: 각 세그먼트를 개별 굵기로 렌더
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const cur = pts[i];
        const pressure = cur.pressure || 0.5;
        ctx.beginPath();
        ctx.lineWidth = stroke.width * (0.3 + pressure * 1.4); // 필압 0~1 → 굵기 30%~170%
        ctx.moveTo(prev.x * w, prev.y * h);
        ctx.lineTo(cur.x * w, cur.y * h);
        ctx.stroke();
      }
    } else {
      // 균일 굵기
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
  if (canvasId === 'dcDR') return curDispPage + 1 <= totalPages ? curDispPage + 1 : curDispPage;
  // portrait 모드: dcPT{n}
  const m = canvasId.match(/dcPT(\d+)/);
  return m ? parseInt(m[1]) : curDispPage;
}

/** PointerEvent 핸들러 등록 */
function attachDrawHandlers(canvas) {
  // 펜 자동 감지를 위해 draw-canvas는 항상 pointer-events를 받아야 함
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

  // 그리기 대상이 아니면 이벤트를 아래 레이어로 관통시킴
  if (!canDraw) {
    // 일시적으로 pointer-events를 비활성화하여 아래 요소가 이벤트를 받도록 함
    const canvas = e.currentTarget;
    canvas.style.pointerEvents = 'none';
    // 같은 위치에서 클릭 이벤트를 재발행
    const below = document.elementFromPoint(e.clientX, e.clientY);
    if (below && below !== canvas) {
      below.dispatchEvent(new PointerEvent(e.type, e));
    }
    // 다음 프레임에 pointer-events 복원
    requestAnimationFrame(() => { canvas.style.pointerEvents = 'auto'; });
    return;
  }

  e.preventDefault();
  e.stopPropagation();
  const canvas = e.currentTarget;
  const pos = getDrawPos(e, canvas);
  const pageNum = getDrawPageNum(canvas.id);

  // 펜 자동 감지 시 툴바 표시
  if (isPen && !drawMode) {
    isPenDrawing = true;
    document.getElementById('drawToolbar').classList.add('open');
    document.getElementById('btnDraw').classList.add('active');
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
  // 실시간 미리보기: 마지막 두 점 그리기
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
    // 필압 기반 굵기 (펜 입력일 때)
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
  // 펜 자동 감지로 그렸다면 툴바 숨기기
  if (isPenDrawing && e.pointerType === 'pen') {
    isPenDrawing = false;
    // 수동 drawMode가 아니면 툴바를 잠시 후 숨김
    if (!drawMode) {
      setTimeout(() => {
        if (!isPenDrawing && !drawMode) {
          document.getElementById('drawToolbar').classList.remove('open');
          document.getElementById('btnDraw').classList.remove('active');
        }
      }, 3000);
    }
  }

  if (!isDrawing || !currentStroke) { isDrawing = false; return; }
  const canvas = e.currentTarget;
  const pageNum = getDrawPageNum(canvas.id);
  // 점이 1개 이상이면 저장
  if (currentStroke.points.length >= 1) {
    loadDrawing(pageNum);
    drawingStrokes[pageNum].push(currentStroke);
    saveDrawing(pageNum);
  }
  currentStroke = null;
  isDrawing = false;
  // 깔끔하게 다시 렌더
  renderDrawing(canvas.id, pageNum);
}

/** 지우개: 특정 위치 근처 스트로크 제거 */
function eraseAt(pageNum, pos, canvasId) {
  const strokes = loadDrawing(pageNum);
  const threshold = 0.025; // 비율 좌표 기준 반경
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

// ── UI 제어 함수 ──

/** 드로잉 모드 토글 (수동) */
function toggleDrawMode() {
  drawMode = !drawMode;
  const btn = document.getElementById('btnDraw');
  const toolbar = document.getElementById('drawToolbar');
  const area = document.getElementById('canvasArea');
  btn.classList.toggle('active', drawMode);
  toolbar.classList.toggle('open', drawMode);
  area.classList.toggle('draw-active', drawMode);
  if (!drawMode) {
    eraserMode = false;
    document.getElementById('btnEraser').classList.remove('active');
    document.querySelectorAll('.draw-canvas').forEach(c => c.classList.remove('eraser-mode'));
  }
  // 드로잉 모드 진입 시 기존 canvasArea onclick 방지
  if (drawMode) {
    area.removeAttribute('onclick');
  } else {
    area.setAttribute('onclick', 'onCanvasTap()');
  }
}

/** 펜 색상 변경 */
function setDrawColor(color, el) {
  drawColor = color;
  document.querySelectorAll('.draw-toolbar .dt-color').forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
  // 지우개 해제
  eraserMode = false;
  document.getElementById('btnEraser').classList.remove('active');
  document.querySelectorAll('.draw-canvas').forEach(c => c.classList.remove('eraser-mode'));
}

/** 펜 굵기 변경 */
function setDrawWidth(w, el) {
  drawWidth = w;
  document.querySelectorAll('.draw-toolbar .dt-width').forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
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
    if (curDispPage + 1 <= totalPages) {
      renderDrawing('dcDR', curDispPage + 1);
    }
  } else if (viewMode === 'portrait') {
    for (let pg = 1; pg <= totalPages; pg++) {
      renderDrawing('dcPT' + pg, pg);
    }
  }
}

/** showView 확장: 뷰 전환 시 드로잉도 함께 렌더링 */
function refreshDrawOnViewChange() {
  // requestAnimationFrame으로 캔버스 크기가 확정된 뒤 렌더
  requestAnimationFrame(() => {
    // static 캔버스에 핸들러 재연결
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
