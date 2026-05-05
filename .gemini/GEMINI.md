# BandScore 프로젝트 규칙

## 아키텍처
- 단일 HTML 파일 (`player.html`, `index.html`) + 외부 JS 모듈 (`drawing.js`, `zoom.js`)
- 서버: Express (Node.js) + SQLite + Socket.IO
- 배포: Railway (Asia 리전)
- Git: `kimyoonchul/bandscore`, 브랜치 `master`

## UI/CSS 규칙
- **테마**: 다크 모드 기반, CSS 변수 `--primary`, `--bg`, `--text` 등 사용
- **솔로/같이하기 모드**: `.player-container.solo` 클래스로 테마 분기
- **z-index 체계**: 오버레이(5~8) < 화살표(20) < 푸터(50) < 설정패널(100) < 헤더(200) < FAB(250) < 카운트오버레이(300) < 모달(2000)
- **모바일**: 768px 이하 미디어쿼리 별도 스타일 적용

## 드로잉 시스템
- 펜 자동 감지 (Apple Pencil/S-Pen) → 자동 드로잉 모드
- 필압 기반 굵기 조절 (0.8 / 1.5 / 3)
- 펜 색상/굵기는 localStorage('drawPrefs')에 저장
- 페이지별 스트로크는 localStorage('drawing_{partId}_{page}')에 저장
- 핀치 줌 중 드로잉 차단 (isPinching 플래그)

## 스타일 설정
- 파트별 악보 스타일(여백, 색상, 굵기 등)은 서버 API `/api/parts/:id/style`에 저장
- 설정 기본값: `STYLE_DEFAULTS` 객체 참조

## 뷰 모드
- single(1벌), dual(2벌 CSS Grid 50:50), portrait(세로 연속 스크롤)
- 세로 모드에서는 화살표 버튼 숨김
- 화살표: 첫 페이지→왼쪽 숨김, 마지막→오른쪽 숨김, UI 숨김 시→전부 숨김

## Git 워크플로
- 작은 변경: commit만, 유저가 "푸시해"하면 push
- 유저가 바로 푸시 요청하면 commit + push 동시 실행
