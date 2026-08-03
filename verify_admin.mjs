import { chromium } from 'playwright';

const ADMIN_EMAIL    = 'audtls2g@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PW || '';
const FIREBASE_API_KEY = 'AIzaSyBL5lQr2VIPK9caokm90g4_eQIkA8EXjqE';

// 관리자 계정 로그인 → idToken 획득
const loginResp = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, returnSecureToken: true }),
  }
);
const loginData = await loginResp.json();
if (!loginData.idToken) {
  console.error('로그인 실패:', JSON.stringify(loginData));
  process.exit(1);
}
console.log('✅ 로그인 성공:', ADMIN_EMAIL);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();

// Firebase Auth 상태를 localStorage에 주입
const page = await ctx.newPage();
await page.goto('https://fillyo.kr/admin/', { waitUntil: 'domcontentloaded', timeout: 20000 });

// Firebase Auth 세션 쿠키 주입 (indexedDB 방식은 복잡하므로 URL 파라미터 우회)
// 대신 직접 admin 페이지 JS 로그인 흐름 모킹
await page.evaluate(({ token, uid, email }) => {
  // Firebase Auth persistence key 형식
  const key = `firebase:authUser:AIzaSyBL5lQr2VIPK9caokm90g4_eQIkA8EXjqE:[DEFAULT]`;
  localStorage.setItem(key, JSON.stringify({
    uid, email,
    stsTokenManager: { accessToken: token, expirationTime: Date.now() + 3600000 },
  }));
}, { token: loginData.idToken, uid: loginData.localId, email: ADMIN_EMAIL });

// 새로고침해서 auth 상태 반영
await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(6000);

await page.screenshot({ path: 'C:/Users/뿌이/Desktop/verify_admin.png' });

// 테이블에서 test@fillyo.kr 또는 test_fillyo1 또는 테스트학원1 검색
const bodyText = await page.evaluate(() => document.body.innerText);
const hasTest  = bodyText.includes('test@fillyo.kr') || bodyText.includes('테스트학원1') || bodyText.includes('test_fillyo1');

console.log('페이지 텍스트 일부:', bodyText.substring(0, 300));
console.log('');
console.log('test@fillyo.kr 목록에 포함 여부:', hasTest ? '❌ 여전히 있음' : '✅ 목록에서 사라짐');

await browser.close();
process.exit(hasTest ? 1 : 0);
