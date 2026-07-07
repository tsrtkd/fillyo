'use strict';
/**
 * test-withdraw-flow.js — executeWithdraw 전체 흐름 검증 (격리된 테스트 계정)
 *
 * 단계:
 *  1. 새 Firebase Auth 테스트 계정 생성 (test_withdraw_XXXXXXXX@test.fillyo.kr)
 *  2. RTDB에 테스트 학원 + 활성 애드온 데이터 직접 생성 (setup 페이지 흉내)
 *  3. 생성된 ID 토큰으로 executeWithdraw Callable 함수 직접 호출
 *  4. 결과 검증 (settlementDue, withdrawnAcademies, users 업데이트)
 *  5. Firebase Auth 테스트 계정 삭제
 *
 * ⚠️ 이 스크립트는 테스트 전용 계정만 건드립니다. PROTECTED_ACADEMY_IDS 미포함.
 * 사용법: node test-withdraw-flow.js
 */

const axios   = require('./functions/node_modules/axios');
const tools   = require('C:/Users/뿌이/.config/configstore/firebase-tools.json');
const AT      = tools.tokens.access_token;

const DB_BASE    = 'https://fillyo-journal-default-rtdb.asia-southeast1.firebasedatabase.app';
const API_KEY    = 'AIzaSyBL5lQr2VIPK9caokm90g4_eQIkA8EXjqE';
const PROJECT    = 'fillyo-journal';
const FN_BASE    = 'https://asia-northeast3-fillyo-journal.cloudfunctions.net';

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

// ── Firebase Auth REST 헬퍼 ─────────────────────────────────────────
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

// ID 토큰 갱신 (만료 시)
async function refreshIdToken(refreshToken) {
  const res = await axios.post(
    `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`,
    { grant_type: 'refresh_token', refresh_token: refreshToken }
  );
  return res.data.id_token;
}

// ── Firebase Callable 함수 호출 ──────────────────────────────────────
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

// ── 메인 ─────────────────────────────────────────────────────────────
async function main() {
  const ts      = Date.now();
  const suffix  = ts.toString(36).slice(-6);
  const email   = `test_withdraw_${suffix}@test.fillyo.kr`;
  const pass    = `Test1234!${suffix}`;
  const acadId  = `test_withdraw_${suffix}`;   // 명시적 test_ 접두사

  console.log('='.repeat(64));
  console.log('  executeWithdraw 전체 흐름 검증 스크립트');
  console.log(`  테스트 계정: ${email}`);
  console.log(`  테스트 학원: ${acadId}`);
  console.log(`  시작 시각: ${new Date(ts).toISOString()}`);
  console.log('='.repeat(64));

  let uid      = null;
  let idToken  = null;
  let refreshToken = null;

  // ================================================================
  //  STEP 1: Firebase Auth 테스트 계정 생성
  // ================================================================
  log('STEP 1: Firebase Auth 테스트 계정 생성');
  try {
    ({ uid, idToken, refreshToken } = await createTestUser(email, pass));
    console.log(`  ✅ 계정 생성 완료 — uid: ${uid}`);
  } catch (e) {
    console.error('  ❌ 계정 생성 실패:', e.response?.data ?? e.message);
    process.exit(1);
  }

  // ================================================================
  //  STEP 2: RTDB에 테스트 학원 + 유저 데이터 생성 (setup 페이지 흉내)
  //  - settings: academyName, planType=pro (할인 구독 중)
  //  - billing: regularAmount=14900, monthlyAmount=9900, paidCount=3 → 위약금=15000
  //  - addons/exam: contract, active, paidCount=2 → 위약금=(9800-4900)*2=9800
  //  - users/{uid}: academyId 링크
  // ================================================================
  log('STEP 2: RTDB 테스트 데이터 생성');
  const now = ts;

  await fb.set(`academies/${acadId}`, {
    settings: {
      academyName: '테스트탈퇴도장',
      name:        '테스트탈퇴도장',
      ownerName:   '테스트관리자',
      phone:       '01000000000',
      type:        'taekwondo',
      planType:    'pro',
      buCount:     4,
      buLabels:    ['1부','2부','3부','4부'],
      createdAt:   now,
    },
    billing: {
      // 할인 구독: 정가 14900원, 할인 9900원, 3회 납부 → 위약금 = (14900-9900)*3 = 15000원
      regularAmount:  14900,
      monthlyAmount:  9900,
      paidCount:      3,
      // billingKey 없음 → PortOne 청구 시도 안 함 (settlementDue 경로로 진행)
    },
    addons: {
      exam: {
        status:          'active',
        billingType:     'contract',
        regularAmount:   9800,
        monthlyAmount:   4900,
        paidCount:       2,          // 위약금 = (9800-4900)*2 = 9800원
        createdAt:       now,
        startDate:       new Date(now).toISOString().slice(0, 10),
        currentPaymentId:  `addon_exam_${acadId}_${now}`,
        currentScheduleId: null,
      },
    },
  });

  await fb.set(`users/${uid}`, {
    academyId:  acadId,
    email,
    ownerName:  '테스트관리자',
    planType:   'pro',
    createdAt:  now,
  });

  console.log(`  ✅ academies/${acadId} 생성 완료`);
  console.log(`  ✅ users/${uid} 생성 완료`);
  console.log(`  💰 예상 위약금: 업무일지 (14900-9900)*3=15,000 + 승급심사 (9800-4900)*2=9,800 = 총 24,800원`);
  console.log(`  🔑 billingKey 없음 → charged=false, settlementDue 기록 예상`);

  // ================================================================
  //  STEP 3: calculateWithdrawSettlement 호출 (위약금 계산 확인)
  // ================================================================
  log('STEP 3: calculateWithdrawSettlement 호출');
  let settlement = null;
  try {
    settlement = await callFunction('calculateWithdrawSettlement', { academyId: acadId }, idToken);
    console.log('  응답:', JSON.stringify(settlement, null, 2));
    assert(settlement.totalPenalty === 24800, `totalPenalty = 24,800원 (계산: ${settlement.totalPenalty})`);
    assert(settlement.journalPenalty === 15000, `journalPenalty = 15,000원`);
    assert(settlement.addonPenalties?.length === 1, `addonPenalties 1건`);
  } catch (e) {
    console.error('  ❌ 호출 실패:', e.response?.data ?? e.message);
    process.exitCode = 1;
  }

  // ================================================================
  //  STEP 4: executeWithdraw 호출 (핵심 테스트)
  // ================================================================
  log('STEP 4: executeWithdraw 호출');
  let withdrawResult = null;
  try {
    // ID 토큰 갱신 (STEP 3 호출 후 시간이 지났을 수 있음)
    idToken = await refreshIdToken(refreshToken);
    withdrawResult = await callFunction('executeWithdraw', { academyId: acadId }, idToken);
    console.log('  응답:', JSON.stringify(withdrawResult, null, 2));
  } catch (e) {
    const errData = e.response?.data ?? e.message;
    console.error('  ❌ executeWithdraw 호출 실패:', errData);
    process.exitCode = 1;
  }

  // ================================================================
  //  STEP 5: 결과 검증 (RTDB 상태 확인)
  // ================================================================
  log('STEP 5: RTDB 결과 검증');

  const acadAfter     = await fb.get(`academies/${acadId}`);
  const withdrawn     = await fb.get(`withdrawnAcademies/${acadId}`);
  const settleDue     = await fb.get(`settlementDue/${acadId}`);
  const userAfter     = await fb.get(`users/${uid}`);

  console.log('\n  academies 삭제 여부:');
  assert(acadAfter === null, `academies/${acadId} 삭제됨 (실제: ${acadAfter === null ? 'null' : '남아있음'})`);

  console.log('\n  withdrawnAcademies 이동 여부:');
  assert(withdrawn !== null, `withdrawnAcademies/${acadId} 존재`);
  assert(withdrawn?._withdrawnAt != null, `_withdrawnAt 타임스탬프 존재`);
  assert(withdrawn?._totalPenalty === 24800, `_totalPenalty = 24,800 (실제: ${withdrawn?._totalPenalty})`);
  assert(withdrawn?._charged === false, `_charged = false (billingKey 없어서)`);

  console.log('\n  settlementDue 기록 여부:');
  assert(settleDue !== null, `settlementDue/${acadId} 존재`);
  assert(settleDue?.amount === 24800, `settlementDue.amount = 24,800 (실제: ${settleDue?.amount})`);

  console.log('\n  users 상태 갱신 여부:');
  assert(userAfter?.planType === 'withdrawn', `users.planType = withdrawn (실제: ${userAfter?.planType})`);
  assert(userAfter?.withdrawnAt != null, `users.withdrawnAt 존재`);

  // ================================================================
  //  STEP 6: 테스트 데이터 정리 (Auth 계정 삭제는 이미 withdrawUser가 했을 수도)
  // ================================================================
  log('STEP 6: 테스트 데이터 정리');
  try {
    // withdrawnAcademies, settlementDue, users 데이터 정리
    await fb.del(`withdrawnAcademies/${acadId}`);
    await fb.del(`settlementDue/${acadId}`);
    await fb.del(`users/${uid}`);
    console.log('  ✅ RTDB 테스트 잔여 데이터 정리 완료');
  } catch (e) {
    console.warn('  ⚠️ RTDB 정리 중 오류 (무시 가능):', e.message);
  }

  // Firebase Auth 계정 삭제 (실패해도 계속)
  try {
    idToken = await refreshIdToken(refreshToken);
    await deleteAuthUser(idToken);
    console.log(`  ✅ Firebase Auth 계정 ${email} 삭제 완료`);
  } catch (e) {
    console.warn(`  ⚠️ Auth 계정 삭제 실패 (이미 삭제됐거나 다른 문제): ${e.response?.data?.error?.message ?? e.message}`);
    // admin으로 강제 삭제
    try {
      await axios.post(
        `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:delete`,
        { localId: uid },
        { headers: { Authorization: `Bearer ${AT}` } }
      );
      console.log(`  ✅ Admin API로 Auth 계정 강제 삭제 완료`);
    } catch (e2) {
      console.warn(`  ⚠️ Admin 강제 삭제도 실패: ${e2.response?.data ?? e2.message}`);
    }
  }

  // ================================================================
  //  최종 결과 요약
  // ================================================================
  console.log('\n' + '═'.repeat(64));
  if (process.exitCode === 1) {
    console.error('❌ 검증 실패 — 위 로그를 확인하세요');
  } else {
    console.log('✅ executeWithdraw 전체 흐름 검증 완료');
    console.log('  - 위약금 계산: 정상 (24,800원 = 업무일지 15,000 + 승급심사 9,800)');
    console.log('  - billingKey 없는 경우: settlementDue 기록 후 탈퇴 정상 완료');
    console.log('  - academies → withdrawnAcademies 이동: 정상');
    console.log('  - users.planType → withdrawn 업데이트: 정상');
  }
  console.log('═'.repeat(64));
}

main().catch(e => {
  console.error('\n💥 스크립트 오류:', e.response?.data ?? e.message);
  process.exit(1);
});
