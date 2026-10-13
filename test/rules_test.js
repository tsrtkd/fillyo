/**
 * FILLYO RTDB 보안 규칙 에뮬레이터 테스트
 *
 * 실행 방법:
 *   1. Java 11+ 설치 확인
 *   2. npm install --save-dev @firebase/rules-unit-testing firebase
 *   3. 터미널 A: firebase emulators:start --only database
 *   4. 터미널 B: node test/rules_test.js
 */

const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');
const fs   = require('fs');
const path = require('path');

const PROJECT_ID   = 'fillyo-journal';
const DATABASE_URL = 'http://127.0.0.1:9000';
const ADMIN_EMAIL  = 'audtls2g@gmail.com';

// 테스트용 UID / academyId (실계정 절대 사용 금지)
const TEST_UID_A   = 'test_uid_alice';
const TEST_UID_B   = 'test_uid_bob';
const TEST_ACAD_A  = 'test_acad_alice';
const TEST_ACAD_B  = 'test_acad_bob';
const ADMIN_UID    = 'test_uid_admin';

// 결과 집계
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

  // ── 헬퍼 ──────────────────────────────────────────────────────────
  const admin = env.authenticatedContext(ADMIN_UID, { email: ADMIN_EMAIL });

  function user(uid, email = `${uid}@test.com`) {
    return env.authenticatedContext(uid, { email });
  }

  async function setupAliceWithAcademy() {
    // 관리자로 alice 계정 + 도장 사전 세팅
    const adb = admin.database();
    await adb.ref(`users/${TEST_UID_A}`).set({
      email: 'alice@test.com', planType: 'trial',
      planExpiry: Date.now() + 80 * 86400000, createdAt: Date.now(), academyId: null,
    });
    await adb.ref(`academies/${TEST_ACAD_A}`).set({
      settings: { academyName: '테스트도장A' },
      members:  { [TEST_UID_A]: 'owner' },
    });
    await adb.ref(`users/${TEST_UID_A}/academyId`).set(TEST_ACAD_A);
  }

  async function setupBobWithAcademy() {
    const adb = admin.database();
    await adb.ref(`users/${TEST_UID_B}`).set({
      email: 'bob@test.com', planType: 'trial',
      planExpiry: Date.now() + 80 * 86400000, createdAt: Date.now(), academyId: TEST_ACAD_B,
    });
    await adb.ref(`academies/${TEST_ACAD_B}`).set({
      settings: { academyName: '테스트도장B' },
      members:  { [TEST_UID_B]: 'owner' },
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 가입 시 role:'admin' 포함
  // ═══════════════════════════════════════════════════════════════════
  await env.clearDatabase();
  try {
    await assertFails(
      user(TEST_UID_A).database().ref(`users/${TEST_UID_A}`).set({
        email: 'alice@test.com', phone: '010', address: 'addr',
        planType: 'trial', planExpiry: Date.now() + 80 * 86400000,
        createdAt: Date.now(), academyId: null,
        role: 'admin',  // ← 악성 필드
      })
    );
    log('차단: 가입 시 role:"admin" 포함', true);
  } catch { log('차단: 가입 시 role:"admin" 포함', false); }

  // ─── 이후 테스트를 위해 alice 정상 가입 ─────────────────────────
  await env.clearDatabase();
  await setupAliceWithAcademy();
  await setupBobWithAcademy();

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 가입 시 남의 academyId 포함
  // ═══════════════════════════════════════════════════════════════════
  const TEST_UID_C = 'test_uid_charlie';
  try {
    await assertFails(
      user(TEST_UID_C).database().ref(`users/${TEST_UID_C}`).set({
        email: 'charlie@test.com', planType: 'trial',
        planExpiry: Date.now() + 80 * 86400000,
        createdAt: Date.now(),
        academyId: TEST_ACAD_A,  // ← alice 도장: charlie는 member가 아님
      })
    );
    log('차단: 가입 시 남의 academyId 포함', true);
  } catch { log('차단: 가입 시 남의 academyId 포함', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] trialStart 미래 값
  // ═══════════════════════════════════════════════════════════════════
  try {
    await assertFails(
      user(TEST_UID_A).database().ref(`users/${TEST_UID_A}/trialStart`)
        .set(Date.now() + 10 * 86400000)  // ← 10일 미래
    );
    log('차단: trialStart 미래 값', true);
  } catch { log('차단: trialStart 미래 값', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 본인이 planType을 'pro'로 변경
  // ═══════════════════════════════════════════════════════════════════
  try {
    await assertFails(
      user(TEST_UID_A).database().ref(`users/${TEST_UID_A}/planType`).set('pro')
    );
    log('차단: 본인이 planType → "pro"', true);
  } catch { log('차단: 본인이 planType → "pro"', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 관장님이 자기 도장 billing.nextPaymentAt 변경
  // ═══════════════════════════════════════════════════════════════════
  await admin.database().ref(`academies/${TEST_ACAD_A}/billing`).set({
    billingKey: 'bk_test', status: 'active', nextPaymentAt: Date.now() + 30 * 86400000,
  });
  try {
    await assertFails(
      user(TEST_UID_A).database()
        .ref(`academies/${TEST_ACAD_A}/billing/nextPaymentAt`)
        .set(Date.now() + 365 * 86400000)
    );
    log('차단: 관장님이 billing.nextPaymentAt 직접 변경', true);
  } catch { log('차단: 관장님이 billing.nextPaymentAt 직접 변경', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 남의 도장 읽기
  // ═══════════════════════════════════════════════════════════════════
  try {
    await assertFails(
      user(TEST_UID_A).database().ref(`academies/${TEST_ACAD_B}`).get()
    );
    log('차단: 남의 도장 읽기', true);
  } catch { log('차단: 남의 도장 읽기', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] 남의 도장 쓰기
  // ═══════════════════════════════════════════════════════════════════
  try {
    await assertFails(
      user(TEST_UID_A).database()
        .ref(`academies/${TEST_ACAD_B}/settings/academyName`)
        .set('해킹도장')
    );
    log('차단: 남의 도장 쓰기', true);
  } catch { log('차단: 남의 도장 쓰기', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] academyId 있는 사람이 새 도장 생성
  // ═══════════════════════════════════════════════════════════════════
  try {
    await assertFails(
      user(TEST_UID_A).database().ref('academies/test_acad_new').set({
        settings: { academyName: '새도장' },
        members:  { [TEST_UID_A]: 'owner' },
      })
    );
    log('차단: academyId 있는 사람이 새 도장 생성', true);
  } catch { log('차단: academyId 있는 사람이 새 도장 생성', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [차단] failedSubscriptions 덮어쓰기
  // ═══════════════════════════════════════════════════════════════════
  await admin.database().ref(`failedSubscriptions/${TEST_ACAD_A}`).set({
    uid: TEST_UID_A, failedAt: Date.now(), reason: '기존 레코드',
  });
  try {
    await assertFails(
      user(TEST_UID_A).database().ref(`failedSubscriptions/${TEST_ACAD_A}`).set({
        uid: TEST_UID_A, failedAt: Date.now(), reason: '덮어쓰기 시도',
      })
    );
    log('차단: failedSubscriptions 덮어쓰기', true);
  } catch { log('차단: failedSubscriptions 덮어쓰기', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] 정상 가입 (login)
  // ═══════════════════════════════════════════════════════════════════
  const TEST_UID_D = 'test_uid_dave';
  try {
    await assertSucceeds(
      user(TEST_UID_D).database().ref(`users/${TEST_UID_D}`).set({
        email: 'dave@test.com', phone: '010-1234-5678', address: '서울',
        planType: 'trial',
        planExpiry: Date.now() + 88 * 86400000,
        createdAt: Date.now(),
        academyId: null,
      })
    );
    log('통과: 정상 가입 (login)', true);
  } catch { log('통과: 정상 가입 (login)', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] setup — 도장 생성 + academyId 연결 (academyId 없는 사람)
  // ═══════════════════════════════════════════════════════════════════
  const TEST_UID_E = 'test_uid_eve';
  const TEST_ACAD_E = 'test_acad_eve';
  await admin.database().ref(`users/${TEST_UID_E}`).set({
    email: 'eve@test.com', planType: 'trial',
    planExpiry: Date.now() + 80 * 86400000, createdAt: Date.now(), academyId: null,
  });
  try {
    await assertSucceeds(
      user(TEST_UID_E).database().ref(`academies/${TEST_ACAD_E}`).set({
        settings: { academyName: '이브도장' },
        members:  { [TEST_UID_E]: 'owner' },
      })
    );
    log('통과: setup 도장 생성', true);
  } catch { log('통과: setup 도장 생성', false); }

  try {
    await assertSucceeds(
      user(TEST_UID_E).database().ref(`users/${TEST_UID_E}/academyId`).set(TEST_ACAD_E)
    );
    log('통과: setup academyId 연결', true);
  } catch { log('통과: setup academyId 연결', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] dashboard — trialStart 최초 기록
  // ═══════════════════════════════════════════════════════════════════
  try {
    await assertSucceeds(
      user(TEST_UID_A).database().ref(`users/${TEST_UID_A}/trialStart`).set(Date.now())
    );
    log('통과: dashboard trialStart 최초 기록', true);
  } catch { log('통과: dashboard trialStart 최초 기록', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] dashboard — readNotices
  // ═══════════════════════════════════════════════════════════════════
  try {
    await assertSucceeds(
      user(TEST_UID_A).database().ref(`users/${TEST_UID_A}/readNotices/notice_001`).set(true)
    );
    log('통과: dashboard readNotices 기록', true);
  } catch { log('통과: dashboard readNotices 기록', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] 관리자 이메일로 role 설정
  // ═══════════════════════════════════════════════════════════════════
  try {
    await assertSucceeds(
      admin.database().ref(`users/${ADMIN_UID}/role`).set('admin')
    );
    log('통과: 관리자 이메일로 role 설정', true);
  } catch { log('통과: 관리자 이메일로 role 설정', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] mypage/pricing — ownerName·phone 수정
  // ═══════════════════════════════════════════════════════════════════
  try {
    await assertSucceeds(
      user(TEST_UID_A).database().ref(`users/${TEST_UID_A}/phone`).set('010-9999-8888')
    );
    log('통과: phone 수정', true);
  } catch { log('통과: phone 수정', false); }

  try {
    await assertSucceeds(
      user(TEST_UID_A).database().ref(`users/${TEST_UID_A}/ownerName`).set('홍길동')
    );
    log('통과: ownerName 수정', true);
  } catch { log('통과: ownerName 수정', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] app — days 저장
  // ═══════════════════════════════════════════════════════════════════
  try {
    await assertSucceeds(
      user(TEST_UID_A).database()
        .ref(`academies/${TEST_ACAD_A}/days/2026-10-13`)
        .set({ event: '정상 수업', attendCount: 20 })
    );
    log('통과: app days 저장', true);
  } catch { log('통과: app days 저장', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] pricing — contracts 기록
  // ═══════════════════════════════════════════════════════════════════
  try {
    await assertSucceeds(
      user(TEST_UID_A).database()
        .ref(`academies/${TEST_ACAD_A}/contracts/contract_001`)
        .set({ planName: 'FILLYO 전체 이용', monthlyAmount: 9900 })
    );
    log('통과: pricing contracts 기록', true);
  } catch { log('통과: pricing contracts 기록', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] dashboard — customRequests
  // ═══════════════════════════════════════════════════════════════════
  const { push: fbPush } = require('firebase/database');
  try {
    await assertSucceeds(
      user(TEST_UID_A).database()
        .ref(`academies/${TEST_ACAD_A}/customRequests`)
        .push({ message: '홈페이지 연결 요청', createdAt: Date.now() })
    );
    log('통과: dashboard customRequests push', true);
  } catch { log('통과: dashboard customRequests push', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] 관리자의 다른 도장 읽기·쓰기
  // ═══════════════════════════════════════════════════════════════════
  try {
    await assertSucceeds(
      admin.database().ref(`academies/${TEST_ACAD_B}`).get()
    );
    log('통과: 관리자 다른 도장 읽기', true);
  } catch { log('통과: 관리자 다른 도장 읽기', false); }

  try {
    await assertSucceeds(
      admin.database().ref(`users/${TEST_UID_B}/planType`).set('pro')
    );
    log('통과: 관리자 users planType 수정', true);
  } catch { log('통과: 관리자 users planType 수정', false); }

  // ═══════════════════════════════════════════════════════════════════
  // [통과] failedSubscriptions 신규 기록 (uid 일치)
  // ═══════════════════════════════════════════════════════════════════
  const failKey = `test_fail_${TEST_UID_A}_${Date.now()}`;
  try {
    await assertSucceeds(
      user(TEST_UID_A).database().ref(`failedSubscriptions/${failKey}`).set({
        uid: TEST_UID_A, academyId: TEST_ACAD_A,
        billingKey: 'bk_test_xxx', failedAt: Date.now(), reason: '테스트 실패',
      })
    );
    log('통과: failedSubscriptions 신규 기록', true);
  } catch { log('통과: failedSubscriptions 신규 기록', false); }

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
  process.exit(1);
});
