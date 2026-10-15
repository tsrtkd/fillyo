/**
 * FILLYO RTDB 보안 규칙 에뮬레이터 테스트
 *
 * 실행 방법:
 *   1. Java 11+ 설치 확인
 *   2. cd test && npm install
 *   3. 터미널 A: firebase emulators:start --only database --project demo-fillyo
 *   4. 터미널 B: cd test && node rules_test.js
 */

const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');
const { ref, set, get, update, push } = require('firebase/database');
const fs   = require('fs');
const path = require('path');

const PROJECT_ID  = 'demo-fillyo';
const ADMIN_EMAIL = 'audtls2g@gmail.com';

const TEST_UID_A  = 'test_uid_alice';
const TEST_UID_B  = 'test_uid_bob';
const TEST_UID_C  = 'test_uid_charlie';
const TEST_UID_D  = 'test_uid_dave';
const TEST_UID_E  = 'test_uid_eve';
const ADMIN_UID   = 'test_uid_admin';
const TEST_ACAD_A = 'test_acad_alice';
const TEST_ACAD_B = 'test_acad_bob';
const TEST_ACAD_E = 'test_acad_eve';

const results = [];
function log(label, passed) {
  const mark = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${mark}  ${label}`);
  results.push({ label, passed });
}

async function run() {
  const rules = fs.readFileSync(
    path.join(__dirname, '..', 'database.rules.json'), 'utf8'
  );

  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: {
      rules,
      host: '127.0.0.1',
      port: 9000,
    },
  });

  // ── 헬퍼: 인증 컨텍스트 ───────────────────────────────────────────
  const adminCtx = env.authenticatedContext(ADMIN_UID, { email: ADMIN_EMAIL });
  const aCtx     = (uid, email = `${uid}@test.com`) =>
    env.authenticatedContext(uid, { email });

  // 규칙 우회(Admin SDK 시뮬레이션): 초기 데이터 세팅 전용
  async function adminSet(path_, data) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), path_), data);
    });
  }

  async function setupAliceWithAcademy() {
    await adminSet(`users/${TEST_UID_A}`, {
      email: 'alice@test.com', planType: 'trial',
      planExpiry: Date.now() + 80 * 86400000, createdAt: Date.now(), academyId: null,
    });
    await adminSet(`academies/${TEST_ACAD_A}`, {
      settings: { academyName: '테스트도장A' },
      members:  { [TEST_UID_A]: 'owner' },
    });
    await adminSet(`users/${TEST_UID_A}/academyId`, TEST_ACAD_A);
  }

  async function setupBobWithAcademy() {
    await adminSet(`users/${TEST_UID_B}`, {
      email: 'bob@test.com', planType: 'trial',
      planExpiry: Date.now() + 80 * 86400000, createdAt: Date.now(), academyId: TEST_ACAD_B,
    });
    await adminSet(`academies/${TEST_ACAD_B}`, {
      settings: { academyName: '테스트도장B' },
      members:  { [TEST_UID_B]: 'owner' },
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 가입 시 role:'admin' 포함
  // ═══════════════════════════════════════════════════════════════════
  await env.clearDatabase();
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertFails(set(ref(db, `users/${TEST_UID_A}`), {
      email: 'alice@test.com', phone: '010', address: 'addr',
      planType: 'trial', planExpiry: Date.now() + 80 * 86400000,
      createdAt: Date.now(), academyId: null,
      role: 'admin',
    }));
    log('차단: 가입 시 role:"admin" 포함', true);
  } catch { log('차단: 가입 시 role:"admin" 포함', false); }

  // ─── alice·bob 사전 세팅 ────────────────────────────────────────
  await env.clearDatabase();
  await setupAliceWithAcademy();
  await setupBobWithAcademy();

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 가입 시 남의 academyId 포함 (charlie → alice 도장)
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_C).database();
    await assertFails(set(ref(db, `users/${TEST_UID_C}`), {
      email: 'charlie@test.com', planType: 'trial',
      planExpiry: Date.now() + 80 * 86400000,
      createdAt: Date.now(),
      academyId: TEST_ACAD_A,
    }));
    log('차단: 가입 시 남의 academyId 포함', true);
  } catch { log('차단: 가입 시 남의 academyId 포함', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] trialStart 미래 값
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertFails(set(ref(db, `users/${TEST_UID_A}/trialStart`),
      Date.now() + 10 * 86400000));
    log('차단: trialStart 미래 값', true);
  } catch { log('차단: trialStart 미래 값', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 본인이 planType을 'pro'로 변경
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertFails(set(ref(db, `users/${TEST_UID_A}/planType`), 'pro'));
    log('차단: 본인이 planType → "pro"', true);
  } catch { log('차단: 본인이 planType → "pro"', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 관장님이 자기 도장 billing.nextPaymentAt 변경
  // ═══════════════════════════════════════════════════════════════════
  await adminSet(`academies/${TEST_ACAD_A}/billing`, {
    billingKey: 'bk_test', status: 'active',
    nextPaymentAt: Date.now() + 30 * 86400000,
  });
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertFails(set(
      ref(db, `academies/${TEST_ACAD_A}/billing/nextPaymentAt`),
      Date.now() + 365 * 86400000
    ));
    log('차단: 관장님이 billing.nextPaymentAt 직접 변경', true);
  } catch { log('차단: 관장님이 billing.nextPaymentAt 직접 변경', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 남의 도장 읽기
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertFails(get(ref(db, `academies/${TEST_ACAD_B}`)));
    log('차단: 남의 도장 읽기', true);
  } catch { log('차단: 남의 도장 읽기', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 남의 도장 쓰기
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertFails(set(
      ref(db, `academies/${TEST_ACAD_B}/settings/academyName`), '해킹도장'
    ));
    log('차단: 남의 도장 쓰기', true);
  } catch { log('차단: 남의 도장 쓰기', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] academyId 있는 사람이 새 도장 생성
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertFails(set(ref(db, 'academies/test_acad_new'), {
      settings: { academyName: '새도장' },
      members:  { [TEST_UID_A]: 'owner' },
    }));
    log('차단: academyId 있는 사람이 새 도장 생성', true);
  } catch { log('차단: academyId 있는 사람이 새 도장 생성', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] failedSubscriptions 덮어쓰기
  // ═══════════════════════════════════════════════════════════════════
  await adminSet(`failedSubscriptions/${TEST_ACAD_A}`, {
    uid: TEST_UID_A, failedAt: Date.now(), reason: '기존 레코드',
  });
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertFails(set(ref(db, `failedSubscriptions/${TEST_ACAD_A}`), {
      uid: TEST_UID_A, failedAt: Date.now(), reason: '덮어쓰기 시도',
    }));
    log('차단: failedSubscriptions 덮어쓰기', true);
  } catch { log('차단: failedSubscriptions 덮어쓰기', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] 정상 가입 (login)
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_D).database();
    await assertSucceeds(set(ref(db, `users/${TEST_UID_D}`), {
      email: 'dave@test.com', phone: '010-1234-5678', address: '서울',
      planType: 'trial',
      planExpiry: Date.now() + 88 * 86400000,
      createdAt: Date.now(),
      academyId: null,
    }));
    log('통과: 정상 가입 (login)', true);
  } catch { log('통과: 정상 가입 (login)', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] setup — 도장 생성 + academyId 연결 (academyId 없는 사람)
  // ═══════════════════════════════════════════════════════════════════
  await adminSet(`users/${TEST_UID_E}`, {
    email: 'eve@test.com', planType: 'trial',
    planExpiry: Date.now() + 80 * 86400000, createdAt: Date.now(), academyId: null,
  });
  try {
    const db = aCtx(TEST_UID_E).database();
    await assertSucceeds(set(ref(db, `academies/${TEST_ACAD_E}`), {
      settings: { academyName: '이브도장' },
      members:  { [TEST_UID_E]: 'owner' },
    }));
    log('통과: setup 도장 생성', true);
  } catch { log('통과: setup 도장 생성', false); }

  try {
    const db = aCtx(TEST_UID_E).database();
    await assertSucceeds(set(ref(db, `users/${TEST_UID_E}/academyId`), TEST_ACAD_E));
    log('통과: setup academyId 연결', true);
  } catch { log('통과: setup academyId 연결', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] dashboard — trialStart 최초 기록
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertSucceeds(set(ref(db, `users/${TEST_UID_A}/trialStart`), Date.now()));
    log('통과: dashboard trialStart 최초 기록', true);
  } catch { log('통과: dashboard trialStart 최초 기록', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] dashboard — readNotices
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertSucceeds(set(ref(db, `users/${TEST_UID_A}/readNotices/notice_001`), true));
    log('통과: dashboard readNotices 기록', true);
  } catch { log('통과: dashboard readNotices 기록', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] 관리자 이메일로 role 설정
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = adminCtx.database();
    await assertSucceeds(set(ref(db, `users/${ADMIN_UID}/role`), 'admin'));
    log('통과: 관리자 이메일로 role 설정', true);
  } catch { log('통과: 관리자 이메일로 role 설정', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] mypage/pricing — ownerName·phone 수정
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertSucceeds(set(ref(db, `users/${TEST_UID_A}/phone`), '010-9999-8888'));
    log('통과: phone 수정', true);
  } catch { log('통과: phone 수정', false); }

  try {
    const db = aCtx(TEST_UID_A).database();
    await assertSucceeds(set(ref(db, `users/${TEST_UID_A}/ownerName`), '홍길동'));
    log('통과: ownerName 수정', true);
  } catch { log('통과: ownerName 수정', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] app — days 저장
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertSucceeds(set(
      ref(db, `academies/${TEST_ACAD_A}/days/2026-10-13`),
      { event: '정상 수업', attendCount: 20 }
    ));
    log('통과: app days 저장', true);
  } catch { log('통과: app days 저장', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] pricing — contracts 기록
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertSucceeds(set(
      ref(db, `academies/${TEST_ACAD_A}/contracts/contract_001`),
      { planName: 'FILLYO 전체 이용', monthlyAmount: 9900 }
    ));
    log('통과: pricing contracts 기록', true);
  } catch { log('통과: pricing contracts 기록', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] dashboard — customRequests push
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertSucceeds(push(
      ref(db, `academies/${TEST_ACAD_A}/customRequests`),
      { message: '홈페이지 연결 요청', createdAt: Date.now() }
    ));
    log('통과: dashboard customRequests push', true);
  } catch { log('통과: dashboard customRequests push', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] 관리자의 다른 도장 읽기·쓰기
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = adminCtx.database();
    await assertSucceeds(get(ref(db, `academies/${TEST_ACAD_B}`)));
    log('통과: 관리자 다른 도장 읽기', true);
  } catch { log('통과: 관리자 다른 도장 읽기', false); }

  try {
    const db = adminCtx.database();
    await assertSucceeds(set(ref(db, `users/${TEST_UID_B}/planType`), 'pro'));
    log('통과: 관리자 users planType 수정', true);
  } catch { log('통과: 관리자 users planType 수정', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] failedSubscriptions 신규 기록 (uid 일치)
  // ═══════════════════════════════════════════════════════════════════
  const failKey = `test_fail_${Date.now()}`;
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertSucceeds(set(ref(db, `failedSubscriptions/${failKey}`), {
      uid: TEST_UID_A, academyId: TEST_ACAD_A,
      billingKey: 'bk_test_xxx', failedAt: Date.now(), reason: '테스트 실패',
    }));
    log('통과: failedSubscriptions 신규 기록', true);
  } catch { log('통과: failedSubscriptions 신규 기록', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 관장님이 staffSecrets 읽기 (브라우저 완전 차단 경로)
  // ═══════════════════════════════════════════════════════════════════
  await adminSet(`staffSecrets/${TEST_ACAD_A}/ownerUid`, TEST_UID_A);
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertFails(get(ref(db, `staffSecrets/${TEST_ACAD_A}`)));
    log('차단: 관장님이 staffSecrets 읽기', true);
  } catch { log('차단: 관장님이 staffSecrets 읽기', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 관장님이 staffSecrets 쓰기 (브라우저 완전 차단 경로)
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertFails(set(
      ref(db, `staffSecrets/${TEST_ACAD_A}/codes/staff_test`),
      { codeHash: 'fakehash', codeSalt: 'fakesalt' }
    ));
    log('차단: 관장님이 staffSecrets 쓰기', true);
  } catch { log('차단: 관장님이 staffSecrets 쓰기', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 관리자 이메일로도 staffSecrets 읽기 차단 (브라우저 규칙)
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = adminCtx.database();
    await assertFails(get(ref(db, `staffSecrets/${TEST_ACAD_A}`)));
    log('차단: 관리자 이메일로도 staffSecrets 읽기 차단', true);
  } catch { log('차단: 관리자 이메일로도 staffSecrets 읽기 차단', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 관장님이 aiCredits 읽기 차단 (서버 전용 경로)
  // ═══════════════════════════════════════════════════════════════════
  await adminSet(`aiCredits/${TEST_ACAD_A}`, { month: '2026-10', freeUsed: 5, packs: {} });
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertFails(get(ref(db, `aiCredits/${TEST_ACAD_A}`)));
    log('차단: 관장님이 aiCredits 읽기 차단', true);
  } catch { log('차단: 관장님이 aiCredits 읽기 차단', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 관장님이 aiCredits 쓰기 차단 (서버 전용 경로)
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertFails(set(ref(db, `aiCredits/${TEST_ACAD_A}/freeUsed`), 0));
    log('차단: 관장님이 aiCredits 쓰기 차단', true);
  } catch { log('차단: 관장님이 aiCredits 쓰기 차단', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] paymentOrders 브라우저 읽기 차단
  // ═══════════════════════════════════════════════════════════════════
  await adminSet('paymentOrders/test_order_001', {
    type: 'aiPoints', academyId: TEST_ACAD_A, uid: TEST_UID_A,
    productId: 'p5000', amount: 5000, status: 'pending', createdAt: Date.now(),
  });
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertFails(get(ref(db, 'paymentOrders/test_order_001')));
    log('차단: 브라우저가 paymentOrders 읽기 차단', true);
  } catch { log('차단: 브라우저가 paymentOrders 읽기 차단', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] paymentOrders 브라우저 쓰기 차단
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertFails(set(ref(db, 'paymentOrders/fake_order'), {
      type: 'aiPoints', academyId: TEST_ACAD_A, uid: TEST_UID_A,
      productId: 'p5000', amount: 5000, status: 'credited', createdAt: Date.now(),
    }));
    log('차단: 브라우저가 paymentOrders 쓰기 차단', true);
  } catch { log('차단: 브라우저가 paymentOrders 쓰기 차단', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] aiCredits lots 브라우저 쓰기 차단
  // ═══════════════════════════════════════════════════════════════════
  try {
    const db = aCtx(TEST_UID_A).database();
    await assertFails(set(ref(db, `aiCredits/${TEST_ACAD_A}/lots/fake_lot`), {
      remaining: 99999, total: 99999, expiresAt: Date.now() + 99999999,
    }));
    log('차단: 브라우저가 aiCredits/lots 쓰기 차단', true);
  } catch { log('차단: 브라우저가 aiCredits/lots 쓰기 차단', false); }

  // ═══════════════════════════════════════════════════════════════════
  // 결과 요약
  // ═══════════════════════════════════════════════════════════════════
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log('\n─────────────────────────────────────────');
  console.log(`결과: ${passed}개 통과 / ${failed}개 실패 / 전체 ${results.length}개`);
  if (failed > 0) {
    console.log('\n실패 목록:');
    results.filter(r => !r.passed).forEach(r => console.log(`  ✗ ${r.label}`));
  }
  console.log('─────────────────────────────────────────\n');

  await env.cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('테스트 오류:', e.message);
  console.error(e.stack);
  process.exit(1);
});
