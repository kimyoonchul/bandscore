const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 64, height: 64 });

  const svgContent = fs.readFileSync(path.join(__dirname, '../public/favicon.svg'), 'utf8');
  const html = `<html><body style="margin:0;padding:0;background:transparent">${svgContent}</body></html>`;
  await page.setContent(html);
  await page.screenshot({
    path: path.join(__dirname, '../public/favicon.png'),
    clip: { x: 0, y: 0, width: 64, height: 64 },
    omitBackground: true
  });

  await browser.close();
  console.log('✅ favicon.png 생성 완료');
})();
