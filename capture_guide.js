const puppeteer = require('puppeteer');
const fs = require('fs');

if (!fs.existsSync('public/images/guide')) {
  fs.mkdirSync('public/images/guide', { recursive: true });
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  console.log('Navigating to login...');
  await page.goto('http://localhost:3001/login');
  
  await page.type('#loginEmail', 'chuli8944@gmail.com');
  await page.type('#loginPw', 'admin1234');
  
  await Promise.all([
    page.click('#loginBtn'),
    page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {})
  ]);

  console.log('Creating stage if needed...');
  try {
    const hasStage = await page.$('.btn-ghost[onclick^="showStageSettings"]');
    if (!hasStage) {
      await page.click('button[onclick="showCreateStageModal()"]');
      await new Promise(r => setTimeout(r, 500));
      await page.type('#newStageName', '합주 테스트 스테이지');
      await page.click('button[onclick="submitCreateStage()"]');
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch(e) {}

  console.log('Taking dashboard screenshot...');
  await page.screenshot({ path: 'public/images/guide/1_dashboard.png' });
  
  console.log('Taking stage settings screenshot...');
  try {
    await page.click('.btn-ghost[onclick^="showStageSettings"]');
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: 'public/images/guide/2_stage_settings.png' });
    await page.click('.btn-close');
    await new Promise(r => setTimeout(r, 500));
  } catch(e) { console.log('No stage setting btn'); }

  // Admin 페이지로 이동해서 곡 관리 스크린샷 캡쳐
  console.log('Taking admin screenshot...');
  await page.goto('http://localhost:3001/admin');
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: 'public/images/guide/3_admin_dashboard.png' });

  // 곡 관리 탭
  await page.click('button[onclick="showAdminTab(\'songs\')"]');
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: 'public/images/guide/4_admin_songs.png' });

  await browser.close();
  console.log('Done screenshots');
})();
