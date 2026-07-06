'use strict';
/**
 * test-bundle-unbundle.js — 번들 분해(하나만 빼기) + 개별 해지 회귀 검증
 *
 * 단계:
 *  1. 테스트 학원 생성 → 3종 통합(bundle) 상태 만들기
 *  2. 승급심사(exam)만 묶음에서 빼기 → unbundle
 *     - PortOne: 13,500원 스케줄 REVOKED, 줄넘기·AI성장리포트 각각 4,900원 SCHEDULED 확인
 *     - Firebase: exam cancelled+위약금, jumprope/report active, bundle dissolved
 *  3. 개별 해지 회귀: 남은 jumprope를 일반 개별 해지 → 기존 로직 그대로 동작 확인
 *  4. 테스트 데이터 정리
 */

const axios = require('./functions/node_modules/axios');
const tools = require('C:/Users/뿌이/.config/configstore/firebase-tools.json');
const AT    = tools.tokens.access_token;

const DB_BASE = 'https://fillyo-journal-default-rtdb.asia-southeast1.firebasedatabase.app';
const API_KEY = 'AIzaSyBL5lQr2VIPK9caokm90g4_eQIkA8EXjqE';
const FN_BASE = 'https://asia-northeast3-fillyo-journal.cloudfunctions.net';
const PORTONE_SECRET = process.env.PORTONE_API_SECRET;

const fb = {
  get:    (path) =>
    axios.get(`${DB_BASE}/${path}.json`, { params: { access_token: AT } })
      .then(r => r.data).catch(() => null),
  set:    (path, data) =>
    axios.put(`${DB_BASE}/${path}.json`, data, { params: { access_token: AT } }).then(r => r.data),
  update: (path, data) =>
    axios.patch(`${DB_BASE}/${path}.json`, data, { params: { access_token: AT } }).then(r => r.data),
  del:    (path) =>
    axios.delete(`${DB_BASE}/${path}.json`, { params: { access_token: AT } }).then(r => r.data),
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
    { headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' }, timeout: 60000 }
  );
  return res.data.result ?? res.data;
}

async function getPortOneSchedule(scheduleId) {
  if (!PORTONE_SECRET) return null;
  try {
    const res = await axios.get(
      `https://api.portone.io/payment-schedules/${scheduleId}`,
      { headers: { Authorization: `PortOne ${PORTONE_SECRET}` } }
    );
    return res.data;
  } catch (e) {
    if (e.response?.status === 404) return { status: 'NOT_FOUND' };
    return null;
  }
}

async function main() {
  const ts     = Date.now();
  const suffix = ts.toString(36).slice(-6);
  const email  = `test_unbundle_${suffix}@test.fillyo.kr`;
  const pass   = `Test1234!${suffix}`;
  const acadId = `test_unbundle_${suffix}`;
  const TEST_BK = 'billing-key-019f2375-acc4-51fa-26f2-21f427a4f718';

  assert(!['ac_mq2avp88kwmd', 'ac_mqeizbqcgyxo'].includes(acadId), '실제 고객 학원 ID와 충돌 없음');

  let uid, idToken, refreshToken;

  // ────────────────────────────────────────────────────────────────
  log('STEP 0: 테스트 계정 + 학원 생성');
  try {
    ({ uid, idToken, refreshToken } = await createTestUser(email, pass));
    await fb.set(`users/${uid}`, { email, academyId: acadId, planType: 'pro', role: 'owner' });
    await fb.set(`academies/${acadId}/billing`, {
      billingKey: TEST_BK, status: 'active',
      monthlyAmount: 29000, regularAmount: 39000, paidCount: 2,
      startDate: new Date().toISOString().slice(0, 10), createdAt: ts,
    });
    await fb.set(`academies/${acadId}/settings`, { name: `테스트학원_분해_${suffix}` });
    log('생성 완료', { uid, acadId });
  } catch (e) {
    console.error('STEP 0 실패:', e.message);
    process.exit(1);
  }

  // ────────────────────────────────────────────────────────────────
  log('STEP 1: 3종 번들 통합 상태 만들기 (exam → jumprope → report 순 신청)');
  let bundleScheduleId = null;
  try {
    idToken = await refreshIdToken(refreshToken);
    await callFunction('subscribeAddon', { academyId: acadId, addonKey: 'exam', billingType: 'contract' }, idToken);

    idToken = await refreshIdToken(refreshToken);
    await callFunction('subscribeAddon', { academyId: acadId, addonKey: 'jumprope', billingType: 'contract' }, idToken);

    // report 신청 → 번들 자동 통합
    idToken = await refreshIdToken(refreshToken);
    const bundleRes = await callFunction('subscribeAddon', { academyId: acadId, addonKey: 'report', billingType: 'contract' }, idToken);
    assert(bundleRes.bundled === true, '번들 자동 통합 완료');
    bundleScheduleId = bundleRes.scheduleId;
    log('번들 통합 결과', bundleRes);

    // 번들 paidCount를 2로 설정해 위약금 계산 테스트 (번들로 2개월 결제한 것처럼)
    await fb.update(`academies/${acadId}/addons/bundle`, { paidCount: 2 });
    log('번들 paidCount → 2 설정 (위약금 계산 검증용)', null);
  } catch (e) {
    console.error('STEP 1 실패:', e.response?.data ?? e.message);
    process.exitCode = 1;
  }

  // ────────────────────────────────────────────────────────────────
  log('STEP 2: 승급심사(exam)만 묶음에서 빼기 → unbundle');
  let unbundleResult;
  let jumpropeNewScheduleId, reportNewScheduleId;
  try {
    idToken = await refreshIdToken(refreshToken);
    unbundleResult = await callFunction('cancelAddon', { academyId: acadId, addonKey: 'exam' }, idToken);
    log('unbundle 결과', unbundleResult);

    assert(unbundleResult.ok === true, 'unbundle ok=true');
    assert(unbundleResult.unbundled === true, 'unbundled=true 반환');
    assert(unbundleResult.removedKey === 'exam', 'removedKey=exam');
    assert(Array.isArray(unbundleResult.restoredKeys) && unbundleResult.restoredKeys.length === 2, 'restoredKeys 2개');
    // 위약금: (9800-4900) × (frozenPaidCount:0 + bundlePaidCount:2) = 4900 × 2 = 9800
    assert(unbundleResult.penalty === 9800, `위약금 9,800원 (실제: ${unbundleResult.penalty})`);
  } catch (e) {
    console.error('STEP 2 실패:', e.response?.data ?? e.message);
    process.exitCode = 1;
  }

  // ────────────────────────────────────────────────────────────────
  log('STEP 3: Firebase 상태 검증');
  try {
    const addons = await fb.get(`academies/${acadId}/addons`);
    log('addons 전체', addons);

    // bundle dissolved
    assert(addons?.bundle?.status === 'dissolved', 'bundle status=dissolved');
    assert(addons?.bundle?.dissolvedBy === 'exam', 'bundle dissolvedBy=exam');

    // exam cancelled + 위약금
    assert(addons?.exam?.status === 'cancelled', 'exam status=cancelled');
    assert(addons?.exam?.pendingCharge?.amount === 9800, `exam pendingCharge.amount=9800 (실제: ${addons?.exam?.pendingCharge?.amount})`);
    assert(addons?.exam?.paidCount === 2, `exam paidCount=2 (frozenPaidCount:0 + bundle:2)`);

    // jumprope active + paidCount 이어받기 (frozenPaidCount:0 + bundle:2 = 2)
    assert(addons?.jumprope?.status === 'active', 'jumprope status=active');
    assert(addons?.jumprope?.paidCount === 2, `jumprope paidCount=2 (frozenPaidCount:0 + bundle:2, 실제: ${addons?.jumprope?.paidCount})`);
    assert(addons?.jumprope?.currentScheduleId, 'jumprope 새 scheduleId 있음');
    jumpropeNewScheduleId = addons?.jumprope?.currentScheduleId;

    // report active + paidCount 이어받기
    assert(addons?.report?.status === 'active', 'report status=active');
    assert(addons?.report?.paidCount === 2, `report paidCount=2 (실제: ${addons?.report?.paidCount})`);
    assert(addons?.report?.currentScheduleId, 'report 새 scheduleId 있음');
    reportNewScheduleId = addons?.report?.currentScheduleId;
  } catch (e) {
    console.error('STEP 3 실패:', e.message);
    process.exitCode = 1;
  }

  // ────────────────────────────────────────────────────────────────
  log('STEP 4: PortOne 스케줄 직접 조회');
  if (PORTONE_SECRET) {
    if (bundleScheduleId) {
      const s = await getPortOneSchedule(bundleScheduleId);
      log(`번들 스케줄(${bundleScheduleId})`, s);
      assert(s?.status === 'REVOKED', `번들 스케줄 REVOKED (실제: ${s?.status})`);
    }
    if (jumpropeNewScheduleId) {
      const s = await getPortOneSchedule(jumpropeNewScheduleId);
      log(`jumprope 새 스케줄(${jumpropeNewScheduleId})`, s);
      assert(s?.status === 'SCHEDULED', `jumprope 새 스케줄 SCHEDULED (실제: ${s?.status})`);
      assert(s?.totalAmount === 4900, `jumprope 스케줄 4,900원 (실제: ${s?.totalAmount})`);
    }
    if (reportNewScheduleId) {
      const s = await getPortOneSchedule(reportNewScheduleId);
      log(`report 새 스케줄(${reportNewScheduleId})`, s);
      assert(s?.status === 'SCHEDULED', `report 새 스케줄 SCHEDULED (실제: ${s?.status})`);
      assert(s?.totalAmount === 4900, `report 스케줄 4,900원 (실제: ${s?.totalAmount})`);
    }
  } else {
    console.log('  ℹ️  PORTONE_API_SECRET 없음 — PortOne 직접 조회 건너뜀');
  }

  // ────────────────────────────────────────────────────────────────
  log('STEP 5: 회귀 테스트 — 개별 해지 (jumprope, 통합 상태 아님)');
  let jumpropeScheduleBeforeCancel;
  try {
    const addons = await fb.get(`academies/${acadId}/addons`);
    jumpropeScheduleBeforeCancel = addons?.jumprope?.currentScheduleId;

    idToken = await refreshIdToken(refreshToken);
    const cancelRes = await callFunction('cancelAddon', { academyId: acadId, addonKey: 'jumprope' }, idToken);
    log('개별 해지 결과', cancelRes);

    assert(cancelRes.ok === true, '개별 해지 ok=true');
    assert(!cancelRes.unbundled, '개별 해지 unbundled=undefined (번들 분해 아님)');

    const addonsAfter = await fb.get(`academies/${acadId}/addons`);
    assert(addonsAfter?.jumprope?.status === 'cancelled', 'jumprope status=cancelled (개별 해지)');

    if (PORTONE_SECRET && jumpropeScheduleBeforeCancel) {
      const s = await getPortOneSchedule(jumpropeScheduleBeforeCancel);
      assert(s?.status === 'REVOKED', `개별 해지 PortOne 스케줄 REVOKED (실제: ${s?.status})`);
    }
  } catch (e) {
    console.error('STEP 5 실패:', e.response?.data ?? e.message);
    process.exitCode = 1;
  }

  // ────────────────────────────────────────────────────────────────
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

  // ────────────────────────────────────────────────────────────────
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
