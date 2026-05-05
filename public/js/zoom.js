/**
 * ================================================================
 * PinchZoom — 악보 핀치 줌 + 팬 기능
 * ================================================================
 * - 세로 모드: transform scale + spacer + 네이티브 스크롤
 * - 싱글 모드: transform scale + JS 팬 (wS)
 * - 듀얼 모드: transform scale + JS 팬 (viewDual 전체)
 * ================================================================
 */

// ── 줌 상태 ──
let zoomScale = 1;
let zoomX = 0;
let zoomY = 0;
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

/** 줌 대상 컨테이너 반환 */
function getZoomContainer() {
  if (viewMode === 'portrait') return document.getElementById('ptInner');
  if (viewMode === 'dual') return document.getElementById('viewDual');
  return document.getElementById('wS'); // single
}

/** 줌 적용 */
function applyZoom() {
  // ── 세로 모드: transform scale + spacer (네이티브 스크롤) ──
  if (viewMode === 'portrait') {
    const inner = document.getElementById('ptInner');
    const spacer = document.getElementById('ptSpacer');
    if (!inner) return;

    if (zoomScale <= 1) {
      inner.style.transform = '';
      if (spacer) { spacer.style.height = '0'; spacer.style.width = '0'; }
    } else {
      inner.style.transform = `scale(${zoomScale})`;
      if (spacer) {
        const contentH = inner.scrollHeight;
        const contentW = inner.scrollWidth;
        spacer.style.height = (contentH * (zoomScale - 1)) + 'px';
        spacer.style.width = (contentW * (zoomScale - 1)) + 'px';
      }
    }
    return;
  }

  // ── 싱글/듀얼 모드: transform + JS 팬 ──
  const el = getZoomContainer();
  if (!el) return;

  // 팬 범위 제한
  if (zoomScale > 1) {
    const area = document.getElementById('canvasArea');
    if (area) {
      const aW = area.clientWidth;
      const aH = area.clientHeight;
      const elW = el.offsetWidth || aW;
      const elH = el.offsetHeight || aH;
      const minX = aW / zoomScale - elW;
      const minY = aH / zoomScale - elH;
      zoomX = Math.max(minX, Math.min(0, zoomX));
      zoomY = Math.max(minY, Math.min(0, zoomY));
    }
  }

  if (zoomScale <= 1) {
    el.style.transform = '';
  } else {
    el.style.transform = `scale(${zoomScale}) translate(${zoomX}px, ${zoomY}px)`;
  }
}

/** 줌 리셋 */
function resetZoom() {
  zoomScale = 1;
  zoomX = 0;
  zoomY = 0;
  // 모든 줌 대상 리셋
  ['ptInner', 'viewDual', 'wS'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.transform = '';
  });
  const spacer = document.getElementById('ptSpacer');
  if (spacer) { spacer.style.height = '0'; spacer.style.width = '0'; }
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

  area.addEventListener('touchstart', (e) => {
    if (drawMode && e.touches.length === 1) return;
    if (e.touches.length === 2) {
      e.preventDefault();
      isPinching = true;
      if (isDrawing) {
        currentStroke = null;
        isDrawing = false;
        refreshAllDrawCanvases();
      }
      pinchStartDist = pinchDist(e.touches);
      pinchStartScale = zoomScale;
      const mid = pinchMid(e.touches);
      pinchMidX = mid.x;
      pinchMidY = mid.y;
      panStartX = mid.x;
      panStartY = mid.y;
      panStartZoomX = zoomX;
      panStartZoomY = zoomY;
    } else if (e.touches.length === 1 && zoomScale > 1 && !drawMode && viewMode !== 'portrait') {
      // 싱글/듀얼 확대 상태에서 1터치 → 팬 (세로모드는 네이티브 스크롤)
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
      const dist = pinchDist(e.touches);
      const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinchStartScale * (dist / pinchStartDist)));
      const oldScale = zoomScale;

      if (newScale <= 1.05) {
        zoomScale = 1;
        zoomX = 0;
        zoomY = 0;
        applyZoom();
        return;
      }

      if (viewMode === 'portrait') {
        // ── 세로 모드: 핀치 중심점 기준 줌 + 스크롤 조정 ──
        const portEl = document.getElementById('viewPortrait');
        const areaRect = area.getBoundingClientRect();
        const mid = pinchMid(e.touches);
        const localX = mid.x - areaRect.left;
        const localY = mid.y - areaRect.top;
        const contentX = (portEl.scrollLeft + localX) / oldScale;
        const contentY = (portEl.scrollTop + localY) / oldScale;
        zoomScale = newScale;
        applyZoom();
        portEl.scrollLeft = contentX * zoomScale - localX;
        portEl.scrollTop = contentY * zoomScale - localY;
      } else {
        // ── 싱글/듀얼: 핀치 중심점 기준 줌 ──
        zoomScale = newScale;
        const areaRect = area.getBoundingClientRect();
        const mid = pinchMid(e.touches);
        const px = mid.x - areaRect.left;
        const py = mid.y - areaRect.top;
        zoomX = panStartZoomX + px * (1/zoomScale - 1/pinchStartScale);
        zoomY = panStartZoomY + py * (1/zoomScale - 1/pinchStartScale);
        const dx = (mid.x - panStartX) / zoomScale;
        const dy = (mid.y - panStartY) / zoomScale;
        zoomX += dx;
        zoomY += dy;
        applyZoom();
      }
    } else if (isPanning && e.touches.length === 1 && zoomScale > 1 && viewMode !== 'portrait') {
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

  // 마우스 휠 줌
  area.addEventListener('wheel', (e) => {
    if (drawMode) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    const oldScale = zoomScale;
    const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomScale + delta));

    if (newScale <= 1.05) {
      zoomScale = 1; zoomX = 0; zoomY = 0;
    } else if (viewMode === 'portrait') {
      const portEl = document.getElementById('viewPortrait');
      const areaRect = area.getBoundingClientRect();
      const localX = e.clientX - areaRect.left;
      const localY = e.clientY - areaRect.top;
      const contentX = (portEl.scrollLeft + localX) / oldScale;
      const contentY = (portEl.scrollTop + localY) / oldScale;
      zoomScale = newScale;
      applyZoom();
      portEl.scrollLeft = contentX * zoomScale - localX;
      portEl.scrollTop = contentY * zoomScale - localY;
      return;
    } else {
      const areaRect = area.getBoundingClientRect();
      const px = e.clientX - areaRect.left;
      const py = e.clientY - areaRect.top;
      zoomX += px * (1/newScale - 1/oldScale);
      zoomY += py * (1/newScale - 1/oldScale);
      zoomScale = newScale;
    }
    applyZoom();
  }, { passive: false });

  // 마우스 드래그 팬 (싱글/듀얼 전용)
  area.addEventListener('mousedown', (e) => {
    if (drawMode || zoomScale <= 1 || viewMode === 'portrait') return;
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
