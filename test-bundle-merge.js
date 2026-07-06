'use strict';
/**
 * test-bundle-merge.js — 3종 애드온 번들 자동 통합 검증
 *
 * 단계:
 *  1. 테스트 Firebase Auth 계정 + 가짜 학원 생성
 *  2. exam → 4,900원 개별 스케줄 생성 확인
 *  3. jumprope → 4,900원 개별 스케줄 생성 확인
 *  4. report 신청 → 번들 자동 통합 확인:
 *     - 기존 2개 스케줄 PortOne에서 취소됐는지
 *     - 13,500원 통합 스케줄 새로 생성됐는지
 *     - Firebase addons/bundle active, exam/jumprope/report merged
 *     - frozenPaidCount 보존 확인
 *  5. 테스트 데이터 정리 (계정·DB)
 *
 * ⚠️ 실제 고객(ac_mq2avp88kwmd, ac_mqeizbqcgyxo) 절대 건드리지 않음
 * 사용법: node test-bundle-merge.js
 */

const axios = require('./functions/node_modules/axios');
const tools = require('C:/Users/뿌이/.config/configstore/firebase-tools.json');
const AT    = tools.tokens.access_token;

const DB_BASE = 'https://fillyo-journal-default-rtdb.asia-southeast1.firebasedatabase.app';
const API_KEY = 'AIzaSyBL5lQr2VIPK9caokm90g4_eQIkA8EXjqE';
const FN_BASE = 'https://asia-northeast3-fillyo-journal.cloudfunctions.net';

// ── RTDB 헬퍼 ────────────────────────────────────────────────────────
const fb = {
  get:    (path) =>
    axios.get(`${DB_BASE}/${path}.json`, { params: { access_token: AT } })
      .then(r => r.data).catch(() => null),
  set:    (path, data) =>
    axios.put(`${DB_BASE}/${path}.json`, data, { params: { access_token: AT } })
      .then(r => r.data),
  update: (path, data) =>
    axios.patch(`${DB_BASE}/${path}.json`, data, { params: { access_token: AT } })
      .then(r => r.data),
  del:    (path) =>
    axios.delete(`${DB_BASE}/${path}.json`, { params: { access_token: AT } })
      .then(r => r.data),
};

function log(label, obj) {
  console.log('\n' + '─'.repeat(64));
  console.log(`[${label}]`);
  if (obj !== undefined) console.log(JSON.stringify(obj, null, 2));
}

function assert(cond, msg) {
  if (!cond) { console.error(`  ❌ FAIL: ${msg}`); process.exitCode = 1; }
  else        { console.log(`  ✅ OK:   ${msg}`); }
}

async function createTestUser(email, password) {
  const res = await axios.post(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    { email, password, returnSecureToken: true }
  );
  return { uid: res.data.localId, idToken: res.data.idToken, refreshToken: res.data.refreshToken };
}

async function deleteAuthUser(idToken) {
  await axios.post(
    `https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${API_KEY}`,
    { idToken }
  );
}

async function refreshIdToken(refreshToken) {
  const res = await axios.post(
    `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`,
    { grant_type: 'refresh_token', refresh_token: refreshToken }
  );
  return res.data.id_token;
}

async function callFunction(fnName, data, idToken) {
  const res = await axios.post(
    `${FN_BASE}/${fnName}`,
    { data },
    {
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );
  return res.data.result ?? res.data;
}

// PortOne 단일 스케줄 조회 (ID로)
async function getPortOneSchedule(scheduleId) {
  const portoneSecret = process.env.PORTONE_API_SECRET;
  if (!portoneSecret) return null;
  try {
    const res = await axios.get(
      `https://api.portone.io/payment-schedules/${scheduleId}`,
      { headers: { Authorization: `PortOne ${portoneSecret}` } }
    );
    return res.data;
  } catch (e) {
    const status = e.response?.status;
    if (status === 404) return { status: 'NOT_FOUND' };
    console.warn('  ⚠️  PortOne 스케줄 조회 실패:', e.response?.data ?? e.message);
    return null;
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────
async function main() {
  const ts     = Date.now();
  const suffix = ts.toString(36).slice(-6);
  const email  = `test_bundle_${suffix}@test.fillyo.kr`;
  const pass   = `Test1234!${suffix}`;
  const acadId = `test_bundle_${suffix}`;   // 명시적 test_ 접두사

  // 안전장치 확인
  assert(!['ac_mq2avp88kwmd', 'ac_mqeizbqcgyxo'].includes(acadId), '실제 고객 학원 ID와 충돌 없음');

  let uid, idToken, refreshToken;
  let examScheduleId = null;
  let jumpropeScheduleId = null;

  log('STEP 0: 테스트 계정 + 가짜 학원 생성');
  try {
    ({ uid, idToken, refreshToken } = await createTestUser(email, pass));
    log('계정 생성', { uid, email, acadId });

    // billingKey: 환경변수 우선, 없으면 PortOne ISSUED 상태의 테스트 전용 키 사용
    // billing-key-019f2375: test-free@fillyo.kr 계정의 KG이니시스 테스트 채널 키 (ISSUED)
    let testBillingKey = process.env.TEST_BILLING_KEY
      || 'billing-key-019f2375-acc4-51fa-26f2-21f427a4f718';
    console.log('  ℹ️  사용 billingKey:', testBillingKey.slice(0, 35) + '...');

    // RTDB에 테스트 학원 데이터 생성
    await fb.set(`users/${uid}`, {
      email,
      academyId: acadId,
      planType: 'pro',
      role: 'owner',
    });
    await fb.set(`academies/${acadId}/billing`, {
      billingKey: testBillingKey,
      status:     'active',
      monthlyAmount: 29000,
      regularAmount: 39000,
      paidCount:  2,
      startDate:  new Date().toISOString().slice(0, 10),
      createdAt:  ts,
    });
    await fb.set(`academies/${acadId}/settings`, {
      name: `테스트학원_번들_${suffix}`,
    });

    log('학원 데이터 생성 완료', { acadId });
  } catch (e) {
    console.error('STEP 0 실패:', e.message);
    process.exit(1);
  }

  // ──────────────────────────────────────────────────────────────────
  log('STEP 1: 승급심사(exam) 개별 신청');
  try {
    idToken = await refreshIdToken(refreshToken);
    const res1 = await callFunction('subscribeAddon', {
      academyId: acadId, addonKey: 'exam', billingType: 'contract',
    }, idToken);
    log('exam 신청 결과', res1);

    assert(res1.ok === true, 'exam 신청 ok=true');
    assert(!res1.bundled, 'exam 신청 시 번들 통합 안 됨');
    assert(res1.scheduleId, 'exam scheduleId 발급됨');
    examScheduleId = res1.scheduleId;

    const examAddon = await fb.get(`academies/${acadId}/addons/exam`);
    log('exam Firebase 상태', examAddon);
    assert(examAddon?.status === 'active', 'exam status=active');
    assert(examAddon?.monthlyAmount === 4900, 'exam monthlyAmount=4900');
    assert(examAddon?.paidCount === 0, 'exam paidCount=0');
  } catch (e) {
    console.error('STEP 1 실패:', e.response?.data ?? e.message);
    process.exitCode = 1;
  }

  // ──────────────────────────────────────────────────────────────────
  log('STEP 2: 줄넘기(jumprope) 개별 신청');
  try {
    idToken = await refreshIdToken(refreshToken);
    const res2 = await callFunction('subscribeAddon', {
      academyId: acadId, addonKey: 'jumprope', billingType: 'contract',
    }, idToken);
    log('jumprope 신청 결과', res2);

    assert(res2.ok === true, 'jumprope 신청 ok=true');
    assert(!res2.bundled, 'jumprope 신청 시 번들 통합 안 됨');
    assert(res2.scheduleId, 'jumprope scheduleId 발급됨');
    jumpropeScheduleId = res2.scheduleId;

    const jumpAddon = await fb.get(`academies/${acadId}/addons/jumprope`);
    log('jumprope Firebase 상태', jumpAddon);
    assert(jumpAddon?.status === 'active', 'jumprope status=active');
    assert(jumpAddon?.monthlyAmount === 4900, 'jumprope monthlyAmount=4900');
    assert(jumpAddon?.paidCount === 0, 'jumprope paidCount=0');
  } catch (e) {
    console.error('STEP 2 실패:', e.response?.data ?? e.message);
    process.exitCode = 1;
  }

  // ──────────────────────────────────────────────────────────────────
  log('STEP 3: AI성장리포트(report) 신청 → 번들 자동 통합');
  let bundleResult;
  try {
    idToken = await refreshIdToken(refreshToken);
    bundleResult = await callFunction('subscribeAddon', {
      academyId: acadId, addonKey: 'report', billingType: 'contract',
    }, idToken);
    log('report 신청 결과 (번들 통합 기대)', bundleResult);

    assert(bundleResult.ok === true, '번들 통합 ok=true');
    assert(bundleResult.bundled === true, '번들 통합 bundled=true');
    assert(bundleResult.scheduleId, '번들 scheduleId 발급됨');
  } catch (e) {
    console.error('STEP 3 실패:', e.response?.data ?? e.message);
    process.exitCode = 1;
  }

  // ──────────────────────────────────────────────────────────────────
  log('STEP 4: Firebase 상태 검증');
  try {
    const addons = await fb.get(`academies/${acadId}/addons`);
    log('addons 전체', addons);

    // bundle 검증
    const bundle = addons?.bundle;
    assert(bundle?.status === 'active', 'bundle status=active');
    assert(bundle?.billingType === 'contract', 'bundle billingType=contract');
    assert(bundle?.contract === 13500, 'bundle contract=13500');
    assert(Array.isArray(bundle?.mergedFrom), 'bundle mergedFrom 배열');
    assert(bundle?.mergedFrom?.includes('exam'), 'bundle mergedFrom에 exam 포함');
    assert(bundle?.mergedFrom?.includes('jumprope'), 'bundle mergedFrom에 jumprope 포함');
    assert(bundle?.mergedFrom?.includes('report'), 'bundle mergedFrom에 report 포함');
    assert(bundle?.paidCount === 0, 'bundle paidCount=0');
    assert(bundle?.scheduleId || bundle?.currentScheduleId, 'bundle scheduleId 저장됨');

    // 개별 3개 merged 검증
    const exam     = addons?.exam;
    const jumprope = addons?.jumprope;
    const report   = addons?.report;

    assert(exam?.status === 'merged', 'exam status=merged');
    assert(jumprope?.status === 'merged', 'jumprope status=merged');
    assert(report?.status === 'merged', 'report status=merged');

    // frozenPaidCount: 신청 전 paidCount가 0이었으므로 0이어야 함
    assert(exam?.frozenPaidCount === 0, 'exam frozenPaidCount=0 (합치기 직전 값 보존)');
    assert(jumprope?.frozenPaidCount === 0, 'jumprope frozenPaidCount=0');
    assert(report?.frozenPaidCount === 0, 'report frozenPaidCount=0 (새로 신청이라 0)');
  } catch (e) {
    console.error('STEP 4 실패:', e.message);
    process.exitCode = 1;
  }

  // ──────────────────────────────────────────────────────────────────
  log('STEP 5: PortOne 스케줄 ID별 직접 조회');
  if (process.env.PORTONE_API_SECRET) {
    if (examScheduleId) {
      const s = await getPortOneSchedule(examScheduleId);
      log(`exam 스케줄(${examScheduleId})`, s);
      const cancelled = s?.status === 'REVOKED' || s?.status === 'CANCELLED' || s?.status === 'NOT_FOUND';
      assert(cancelled, `exam 스케줄 취소됨 (status=${s?.status})`);
    }
    if (jumpropeScheduleId) {
      const s = await getPortOneSchedule(jumpropeScheduleId);
      log(`jumprope 스케줄(${jumpropeScheduleId})`, s);
      const cancelled = s?.status === 'REVOKED' || s?.status === 'CANCELLED' || s?.status === 'NOT_FOUND';
      assert(cancelled, `jumprope 스케줄 취소됨 (status=${s?.status})`);
    }
    if (bundleResult?.scheduleId) {
      const s = await getPortOneSchedule(bundleResult.scheduleId);
      log(`번들 스케줄(${bundleResult.scheduleId})`, s);
      assert(s && s.status !== 'NOT_FOUND', `번들 스케줄 PortOne에 존재 (status=${s?.status})`);
      if (s && s.status !== 'NOT_FOUND') {
        const amt = s.totalAmount ?? s.payment?.amount?.total ?? s.amount?.total;
        assert(amt === 13500, `번들 스케줄 금액 13,500원 (실제=${amt})`);
      }
    }
  } else {
    console.log('  ℹ️  PORTONE_API_SECRET 없음 — PortOne 직접 조회 건너뜀');
    console.log('     환경변수 추가 후 재실행: PORTONE_API_SECRET=xxx node test-bundle-merge.js');
  }

  // ──────────────────────────────────────────────────────────────────
  log('CLEANUP: 테스트 데이터 삭제');
  try {
    await fb.del(`academies/${acadId}`);
    await fb.del(`users/${uid}`);
    idToken = await refreshIdToken(refreshToken);
    await deleteAuthUser(idToken);
    console.log('  ✅ OK:   테스트 데이터 및 계정 삭제 완료');
  } catch (e) {
    console.warn('  ⚠️  정리 중 오류 (수동 삭제 필요):', e.message);
    console.warn(`     academies/${acadId}, users/${uid}`);
  }

  // paymentOrders는 번들 paymentId로 저장됨 — 조회 후 삭제
  if (bundleResult?.paymentId) {
    try {
      await fb.del(`paymentOrders/${bundleResult.paymentId}`);
    } catch {}
  }

  // ──────────────────────────────────────────────────────────────────
  log('결과 요약');
  if (process.exitCode === 1) {
    console.log('\n⚠️  일부 검증 실패 — 위 로그 확인');
  } else {
    console.log('\n🎉 모든 검증 통과');
  }
}

main().catch(e => {
  console.error('예외 발생:', e);
  process.exit(1);
});
