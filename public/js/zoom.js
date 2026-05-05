/**
 * ================================================================
 * PinchZoom — 악보 핀치 줌 + 팬 기능
 * ================================================================
 * - 핀치 제스처로 악보 확대/축소
 * - 확대 상태에서 드래그로 이동(팬)
 * - 마우스 휠 줌 지원
 * - 헤더/푸터는 고정, canvasArea 내부만 확대
 * ================================================================
 */

// ── 줌 상태 ──
let zoomScale = 1;
let zoomX = 0;       // 팬 오프셋 X
let zoomY = 0;       // 팬 오프셋 Y
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;

// 핀치 제스처 감지용
let pinchStartDist = 0;
let pinchStartScale = 1;
let pinchMidX = 0, pinchMidY = 0;
let isPinching = false;

// 팬 (드래그 이동)
let isPanning = false;
let panStartX = 0, panStartY = 0;
let panStartZoomX = 0, panStartZoomY = 0;

/** 줌/팬 적용 (CSS transform) */
function applyZoom() {
  const containers = [];
  if (viewMode === 'single') {
    containers.push(document.getElementById('wS'));
  } else if (viewMode === 'dual') {
    containers.push(document.getElementById('wDL'));
    containers.push(document.getElementById('wDR'));
  } else if (viewMode === 'portrait') {
    containers.push(document.getElementById('ptInner'));
  }
  containers.forEach(el => {
    if (!el) return;
    if (zoomScale <= 1) {
      el.style.transform = viewMode === 'portrait'
        ? el.style.transform  // portrait는 translateY를 유지
        : '';
      return;
    }
    if (viewMode === 'portrait') {
      // portrait 모드: 기존 translateY + 줌
      const currentTransform = el.style.transform || '';
      const tyMatch = currentTransform.match(/translateY\(([^)]+)\)/);
      const ty = tyMatch ? tyMatch[1] : '0px';
      el.style.transform = `translateY(${ty}) scale(${zoomScale}) translate(${zoomX}px, ${zoomY}px)`;
    } else {
      el.style.transform = `scale(${zoomScale}) translate(${zoomX}px, ${zoomY}px)`;
    }
  });
}

/** 줌 리셋 */
function resetZoom() {
  zoomScale = 1;
  zoomX = 0;
  zoomY = 0;
  applyZoom();
}

/** 핀치 거리 계산 */
function pinchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

/** 핀치 중심점 */
function pinchMid(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2
  };
}

/** canvasArea에 핀치 줌 이벤트 등록 */
function initPinchZoom() {
  const area = document.getElementById('canvasArea');

  // 터치 이벤트 (2손가락: 핀치 줌 + 팬)
  area.addEventListener('touchstart', (e) => {
    if (drawMode && e.touches.length === 1) return; // 드로잉 중 1터치는 그리기
    if (e.touches.length === 2) {
      e.preventDefault();
      isPinching = true;
      // 진행 중인 드로잉 스트로크 취소
      if (isDrawing) {
        currentStroke = null;
        isDrawing = false;
      }
      pinchStartDist = pinchDist(e.touches);
      pinchStartScale = zoomScale;
      const mid = pinchMid(e.touches);
      pinchMidX = mid.x;
      pinchMidY = mid.y;
      // 2손가락 팬 시작점도 기록
      panStartX = mid.x;
      panStartY = mid.y;
      panStartZoomX = zoomX;
      panStartZoomY = zoomY;
    } else if (e.touches.length === 1 && zoomScale > 1 && !drawMode) {
      // 확대 상태에서 1터치 → 팬 (드로잉 모드 아닐 때)
      isPanning = true;
      panStartX = e.touches[0].clientX;
      panStartY = e.touches[0].clientY;
      panStartZoomX = zoomX;
      panStartZoomY = zoomY;
    }
  }, { passive: false });

  area.addEventListener('touchmove', (e) => {
    if (isPinching && e.touches.length === 2) {
      e.preventDefault();
      // 핀치 줌
      const dist = pinchDist(e.touches);
      const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinchStartScale * (dist / pinchStartDist)));
      zoomScale = newScale;
      if (zoomScale <= 1.05) {
        zoomScale = 1;
        zoomX = 0;
        zoomY = 0;
      } else {
        // 2손가락 팬: 중심점 이동량 반영
        const mid = pinchMid(e.touches);
        const dx = (mid.x - panStartX) / zoomScale;
        const dy = (mid.y - panStartY) / zoomScale;
        zoomX = panStartZoomX + dx;
        zoomY = panStartZoomY + dy;
      }
      applyZoom();
    } else if (isPanning && e.touches.length === 1 && zoomScale > 1) {
      e.preventDefault();
      const dx = (e.touches[0].clientX - panStartX) / zoomScale;
      const dy = (e.touches[0].clientY - panStartY) / zoomScale;
      zoomX = panStartZoomX + dx;
      zoomY = panStartZoomY + dy;
      applyZoom();
    }
  }, { passive: false });

  area.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) isPinching = false;
    if (e.touches.length === 0) isPanning = false;
  });

  // 마우스 휠 줌 (Ctrl + 휠 또는 일반 휠)
  area.addEventListener('wheel', (e) => {
    if (drawMode) return; // 드로잉 모드에서는 휠 줌 비활성
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomScale + delta));
    if (newScale <= 1.05) {
      zoomScale = 1;
      zoomX = 0;
      zoomY = 0;
    } else {
      zoomScale = newScale;
    }
    applyZoom();
  }, { passive: false });

  // 마우스 드래그 팬 (확대 상태에서)
  area.addEventListener('mousedown', (e) => {
    if (drawMode || zoomScale <= 1) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartZoomX = zoomX;
    panStartZoomY = zoomY;
    area.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isPanning || zoomScale <= 1) return;
    const dx = (e.clientX - panStartX) / zoomScale;
    const dy = (e.clientY - panStartY) / zoomScale;
    zoomX = panStartZoomX + dx;
    zoomY = panStartZoomY + dy;
    applyZoom();
  });

  document.addEventListener('mouseup', () => {
    if (isPanning) {
      isPanning = false;
      const area = document.getElementById('canvasArea');
      if (area) area.style.cursor = drawMode ? 'crosshair' : 'pointer';
    }
  });
}
