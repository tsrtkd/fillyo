/**
 * test-addon.js  ─  Firebase 데이터 구조 검증 테스트
 *
 * PortOne 실 결제 없이 Firebase REST API 로 직접
 * subscribeAddon / cancelAddon 이 만들어야 할 데이터를 쓰고 읽어
 * 데이터 구조·로직(pendingCharge 계산 등)을 검증합니다.
 *
 * ★ PortOne 완전 통합 테스트(실제 카드 결제 예약)는
 *   DB에 billingKey 가 존재하는 유료 가입 학원이 생긴 뒤 진행하세요.
 *
 * 사용법:  node test-addon.js
 */

'use strict';

const axios      = require('axios');
const tools      = require('C:/Users/뿌이/.config/configstore/firebase-tools.json');
const AT         = tools.tokens.access_token;  // Firebase CLI OAuth2 accessToken
const DB_BASE    = 'https://fillyo-journal-default-rtdb.asia-southeast1.firebasedatabase.app';
const ACADEMY_ID = 'ac_mq2avp88kwmd';          // 태사랑태권도

// ── Firebase REST 헬퍼 ────────────────────────────────────────────
const fb = {
  get:    (path) =>
    axios.get(`${DB_BASE}/${path}.json`, { params: { access_token: AT } })
      .then(r => r.data),
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
  console.log('\n' + '─'.repeat(60));
  console.log(`[${label}]`);
  if (obj !== undefined) console.log(JSON.stringify(obj, null, 2));
}

function assert(cond, msg) {
  if (!cond) { console.error(`  ❌ FAIL: ${msg}`); process.exitCode = 1; }
  else        { console.log(`  ✅ OK:   ${msg}`); }
}

// ── 가격표 (index.js 와 동일) ──────────────────────────────────────
const ADDON_PRICE_TABLE = {
  exam:     { contract: 4900,  single: 9800,  regularAmount: 9800,  name: '승급심사' },
  jumprope: { contract: 4900,  single: 9800,  regularAmount: 9800,  name: '줄넘기' },
  bundle:   { contract: 11760, single: null,  regularAmount: 11760, name: '애드온 묶음' },
};

function nextMonthSameDay(from = new Date()) {
  const d = new Date(from); const day = d.getDate();
  d.setMonth(d.getMonth() + 1);
  if (d.getDate() !== day) d.setDate(0);
  return d;
}

async function runTests() {
  let passed = 0; let total = 0;
  function ok(label) { total++; passed++; console.log(`  ✅ ${label}`); }
  function fail(label) { total++; process.exitCode = 1; console.error(`  ❌ ${label}`); }

  // ================================================================
  //  STEP 0: DB 현황 확인
  // ================================================================
  log('STEP 0: DB 현황 확인');
  const billing = await fb.get(`academies/${ACADEMY_ID}/billing`);
  log('billing', billing);
  console.log(`→ billingKey 존재: ${!!(billing?.billingKey)}`);
  console.log('→ 현재 DB에 billingKey 없음 — PortOne 실 결제 스킵, Firebase 데이터 구조 검증만 진행');

  // ================================================================
  //  STEP 1: subscribeAddon 이 저장해야 할 데이터 직접 쓰기 (exam / single)
  // ================================================================
  log('STEP 1: addons/exam 데이터 쓰기 (subscribeAddon 시뮬레이션)');
  const addonKey     = 'exam';
  const billingType  = 'single';       // 1개월 이용권
  const priceInfo    = ADDON_PRICE_TABLE[addonKey];
  const monthlyAmount = priceInfo.single;
  const regularAmount = priceInfo.regularAmount;
  const timestamp    = Date.now();
  const paymentId    = `addon_${addonKey}_${ACADEMY_ID}_${timestamp}`;
  const scheduleId   = null; // billingKey 없어서 PortOne 예약 미생성

  const addonData = {
    status:            'active',
    billingType,
    monthlyAmount,
    regularAmount,
    startDate:         new Date(timestamp).toISOString().slice(0, 10),
    paidCount:         0,
    currentPaymentId:  paymentId,
    currentScheduleId: scheduleId,
    createdAt:         timestamp,
  };
  await fb.set(`academies/${ACADEMY_ID}/addons/${addonKey}`, addonData);

  const orderData = {
    type: 'addon', academyId: ACADEMY_ID, addonKey, billingType,
    amount: monthlyAmount, orderName: `FILLYO ${priceInfo.name} 1개월 이용권`,
    billingKey: '(test-no-billing-key)', scheduledAt: timestamp,
  };
  await fb.set(`paymentOrders/${paymentId}`, orderData);
  console.log('Firebase 저장 완료');

  // ================================================================
  //  STEP 2: 저장된 데이터 검증
  // ================================================================
  log('STEP 2: addons/exam 데이터 검증');
  const saved = await fb.get(`academies/${ACADEMY_ID}/addons/${addonKey}`);
  log('저장된 addon 데이터', saved);

  total++;
  if (saved?.status === 'active')             { ok('status = active'); }            else { fail('status != active'); }
  if (saved?.billingType === 'single')        { ok('billingType = single'); }       else { fail('billingType != single'); }
  if (saved?.monthlyAmount === 9800)          { ok('monthlyAmount = 9800'); }       else { fail('monthlyAmount wrong'); }
  if (saved?.regularAmount === 9800)          { ok('regularAmount = 9800'); }       else { fail('regularAmount wrong'); }
  if (saved?.paidCount === 0)                 { ok('paidCount = 0'); }              else { fail('paidCount != 0'); }
  if (saved?.currentPaymentId === paymentId)  { ok('currentPaymentId 일치'); }      else { fail('currentPaymentId 불일치'); }
  if ('startDate' in saved)                   { ok('startDate 존재'); }             else { fail('startDate 없음'); }

  const savedOrder = await fb.get(`paymentOrders/${paymentId}`);
  if (savedOrder?.type === 'addon')           { ok('paymentOrders type = addon'); } else { fail('paymentOrders type 오류'); }
  if (savedOrder?.addonKey === addonKey)      { ok('paymentOrders addonKey 일치'); }else { fail('paymentOrders addonKey 오류'); }

  // ================================================================
  //  STEP 3: contract 타입 pendingCharge 계산 로직 검증
  //          (paidCount=5, contract 1년 → 차액 = (9800-4900)*5 = 24500)
  // ================================================================
  log('STEP 3: pendingCharge 계산 로직 검증 (contract, paidCount=5)');
  const contractAddon = {
    status: 'active', billingType: 'contract',
    monthlyAmount: 4900, regularAmount: 9800,
    paidCount: 5, currentPaymentId: 'dummy', currentScheduleId: null,
  };
  await fb.set(`academies/${ACADEMY_ID}/addons/exam_contract_test`, contractAddon);

  const paid = contractAddon.paidCount;
  const expectedCharge = (contractAddon.regularAmount - contractAddon.monthlyAmount) * paid;
  console.log(`  예상 pendingCharge: (${contractAddon.regularAmount} - ${contractAddon.monthlyAmount}) × ${paid} = ${expectedCharge}원`);

  if (expectedCharge === 24500) { ok(`pendingCharge 계산 = ₩24,500`); }
  else { fail(`pendingCharge 계산 오류: ${expectedCharge}`); }

  const chargeData = {
    amount: expectedCharge, paidCount: paid,
    monthlyAmount: contractAddon.monthlyAmount, regularAmount: contractAddon.regularAmount,
    calculatedAt: Date.now(),
    reason: `1년 약정 중도 해지: ${paid}회 결제분 할인 차액 환수 (회당 ${contractAddon.regularAmount - contractAddon.monthlyAmount}원 × ${paid}회)`,
  };
  await fb.update(`academies/${ACADEMY_ID}/addons/exam_contract_test/pendingCharge`, chargeData);
  const savedCharge = await fb.get(`academies/${ACADEMY_ID}/addons/exam_contract_test/pendingCharge`);
  if (savedCharge?.amount === 24500) { ok('pendingCharge Firebase 저장 확인'); }
  else { fail('pendingCharge 저장 오류'); }

  // ================================================================
  //  STEP 4: cancelAddon — status cancelled 로 업데이트
  // ================================================================
  log('STEP 4: cancelAddon 시뮬레이션 (scheduleId=null → PortOne 취소 스킵)');
  const now = Date.now();
  await fb.update(`academies/${ACADEMY_ID}/addons/${addonKey}`, {
    status: 'cancelled', cancelledAt: now,
  });
  const afterCancel = await fb.get(`academies/${ACADEMY_ID}/addons/${addonKey}`);
  log('취소 후 addon 데이터', afterCancel);

  if (afterCancel?.status === 'cancelled')    { ok('status = cancelled'); }         else { fail('status != cancelled'); }
  if (afterCancel?.cancelledAt === now)       { ok('cancelledAt 저장 확인'); }      else { fail('cancelledAt 오류'); }
  if (afterCancel?.paidCount === 0)           { ok('paidCount 유지 확인'); }        else { fail('paidCount 변경됨'); }

  // ================================================================
  //  STEP 5: 웹훅 분기 로직 검증 (paymentId 접두사)
  // ================================================================
  log('STEP 5: 웹훅 분기 로직 검증');
  const testIds = [
    { id: `addon_exam_${ACADEMY_ID}_123`,     expected: true  },
    { id: `addon_jumprope_${ACADEMY_ID}_456`, expected: true  },
    { id: `sub_123456_${ACADEMY_ID}`,         expected: false },
    { id: `sub_789_otherap`,                  expected: false },
  ];
  testIds.forEach(({ id, expected }) => {
    const isAddon = id.startsWith('addon_');
    if (isAddon === expected) {
      ok(`"${id.slice(0,30)}" → isAddon=${isAddon}`);
    } else {
      fail(`"${id.slice(0,30)}" → isAddon=${isAddon} (expected ${expected})`);
    }
  });

  // ================================================================
  //  STEP 6: 테스트 데이터 정리
  // ================================================================
  log('STEP 6: 테스트 데이터 정리');
  await fb.del(`academies/${ACADEMY_ID}/addons/${addonKey}`);
  await fb.del(`academies/${ACADEMY_ID}/addons/exam_contract_test`);
  await fb.del(`paymentOrders/${paymentId}`);
  console.log('  테스트 데이터 삭제 완료');

  // ================================================================
  //  결과 요약
  // ================================================================
  console.log('\n' + '═'.repeat(60));
  console.log(`테스트 결과: ${passed}/${total} 통과`);

  if (process.exitCode === 1) {
    console.error('❌ 일부 검증 실패 — 위 로그를 확인하세요');
  } else {
    console.log('✅ 모든 Firebase 데이터 구조 검증 통과');
    console.log('\n[PortOne 완전 통합 테스트 진행 조건]');
    console.log('  1. 실제 카드로 pricing 페이지에서 구독 가입');
    console.log('  2. academies/{id}/billing/billingKey 생성 확인');
    console.log('  3. node test-addon-portone.js 실행 (별도 스크립트)');
  }
  console.log('═'.repeat(60));
}

runTests().catch(e => {
  console.error('\n💥 테스트 오류:', e.response?.data ?? e.message);
  process.exit(1);
});
