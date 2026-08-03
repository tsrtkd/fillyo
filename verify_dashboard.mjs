import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setViewportSize({ width: 390, height: 844 });
await page.goto('https://fillyo.kr/dashboard/', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: 'C:/Users/뿌이/Desktop/verify_dashboard.png' });

const cards = await page.evaluate(() => {
  const ids = ['cardApp','cardJumprope','cardExam','cardReport','cardAIDesk','cardSlowmo','cardPolicy'];
  return ids.map(id => {
    const el = document.getElementById(id);
    if (!el) return { id, found: false };
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return {
      id,
      found: true,
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
});
console.log(JSON.stringify(cards, null, 2));
await browser.close();
