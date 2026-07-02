import { chromium } from '@playwright/test';
import { createWriteStream } from 'fs';
import path from 'path';

const EMAIL = 'audtls2g@naver.com';
const PW    = process.argv[2] || '';
const BASE  = 'http://localhost:4000';
const SS_DIR = '.';

async function ss(page, name) {
  const p = path.join(SS_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  console.log(`[screenshot] ${p}`);
  return p;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();
  page.on('console', m => console.log(`[browser] ${m.type()}: ${m.text()}`));

  // ── 1. 로그인 페이지 ────────────────────────────────────────────
  await page.goto(BASE + '/login/');
  await page.waitForLoadState('networkidle');
  await ss(page, '01-login');

  await page.fill('input[type=email]', EMAIL);
  if (PW) {
    await page.fill('input[type=password]', PW);
    await page.click('button[onclick*="doLogin"]');
    await page.waitForLoadState('networkidle');
    await ss(page, '02-after-login');
  }

  // ── 2. 마이페이지 직접 이동 ──────────────────────────────────────
  await page.goto(BASE + '/mypage/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000); // Firebase auth/data load
  await ss(page, '03-mypage-loaded');

  // ── 3. 애드온 섹션 확인 ──────────────────────────────────────────
  const addonSec = await page.locator('#addonSection').isVisible();
  console.log(`[check] #addonSection visible: ${addonSec}`);

  const addonContent = await page.locator('#addonContent').innerHTML().catch(() => '(error)');
  console.log(`[check] addonContent preview: ${addonContent.slice(0, 200)}`);

  await ss(page, '04-addon-section');

  await browser.close();
  console.log('[done] Screenshots saved.');
}

main().catch(e => { console.error(e); process.exit(1); });
