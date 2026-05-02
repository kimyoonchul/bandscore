// 악보 왼쪽 bracket 분석 스크립트
const fs = require('fs');
const path = require('path');

// pdf.js 대신 간단한 분석: 업로드된 PDF 중 기타 악보의 시스템 정보 확인
// 서버 API를 통해 현재 감지된 시스템 데이터 출력

const http = require('http');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

(async () => {
  try {
    const songs = await get('http://localhost:3001/api/songs');
    console.log('=== Songs ===');
    for (const s of songs) {
      console.log(`Song: ${s.title}`);
      for (const p of s.parts) {
        console.log(`  Part: ${p.name} (${p.original_filename})`);
        console.log(`  PDF: ${p.pdf_filename}`);
        if (p.systems && p.systems.length > 0) {
          console.log(`  Systems: ${p.systems.length}`);
          for (const sys of p.systems) {
            console.log(`    Page${sys.page_number} Sys${sys.system_index}: top=${sys.top_pct}% bot=${sys.bottom_pct}% measures=${sys.measures}`);
          }
        }
      }
    }
  } catch(e) {
    console.error(e.message);
  }
})();
