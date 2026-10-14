'use strict';
/**
 * AI 크레딧 순수 함수 테스트 (포인트 방식)
 * 실행: node functions/test_credits.js
 *
 * _reserveCredit / _refundCredit / _computeCreditsInfo 를 인라인으로 재정의해 독립 실행.
 */

const assert = require('assert');

// ── 상수 (functions/index.js와 동일하게 유지) ────────────────────────────
const FREE_LIMIT      = 30;
const POINTS_PER_REPORT = 100;
const POINT_PRODUCTS = {
  p5000:  { amount: 5000,  paidPoints: 5000,  bonusPoints: 0,    total: 5000  },
  p10000: { amount: 10000, paidPoints: 10000, bonusPoints: 0,    total: 10000 },
  p30000: { amount: 30000, paidPoints: 30000, bonusPoints: 3000, total: 33000 },
};

// ── 순수 함수 (functions/index.js와 동일하게 유지) ─────────────────────────
function _reserveCredit(current, now, monthKey) {
  let s = current
    ? { month: current.month, freeUsed: current.freeUsed || 0, lots: current.lots ? { ...current.lots } : {} }
    : { month: monthKey, freeUsed: 0, lots: {} };
  if (s.month !== monthKey) { s.month = monthKey; s.freeUsed = 0; }

  if (s.freeUsed < FREE_LIMIT) {
    return { next: { ...s, freeUsed: s.freeUsed + 1 }, usedFrom: 'free' };
  }

  const validLots = Object.entries(s.lots)
    .filter(([, l]) => !l.revokedAt && l.remaining > 0 && l.expiresAt > now)
    .sort(([, a], [, b]) => a.expiresAt - b.expiresAt);
  const available = validLots.reduce((sum, [, l]) => sum + l.remaining, 0);
  if (available < POINTS_PER_REPORT) return null;

  let needed = POINTS_PER_REPORT;
  const deducted = [];
  const newLots = { ...s.lots };
  for (const [lotId, lot] of validLots) {
    if (needed <= 0) break;
    const take = Math.min(lot.remaining, needed);
    newLots[lotId] = { ...lot, remaining: lot.remaining - take };
    deducted.push({ lotId, points: take });
    needed -= take;
  }
  return { next: { ...s, lots: newLots }, usedFrom: deducted };
}

function _refundCredit(current, usedFrom, monthKey) {
  if (!current) return current;
  const s = { month: current.month, freeUsed: current.freeUsed || 0, lots: current.lots ? { ...current.lots } : {} };
  if (usedFrom === 'free') {
    if (s.month === monthKey) s.freeUsed = Math.max(0, s.freeUsed - 1);
  } else {
    for (const { lotId, points } of usedFrom) {
      const lot = s.lots[lotId];
      if (lot) s.lots[lotId] = { ...lot, remaining: lot.remaining + points };
    }
  }
  return s;
}

function _computeCreditsInfo(state, now, monthKey) {
  const s = (!state || state.month !== monthKey)
    ? { freeUsed: 0, lots: {} }
    : { freeUsed: state.freeUsed || 0, lots: state.lots || {} };
  const freeRemaining = Math.max(0, FREE_LIMIT - s.freeUsed);
  const validLots = Object.entries(s.lots)
    .filter(([, l]) => !l.revokedAt && l.remaining > 0 && l.expiresAt > now);
  const totalPoints = validLots.reduce((sum, [, l]) => sum + l.remaining, 0);
  const pointReports = Math.floor(totalPoints / POINTS_PER_REPORT);
  const nearestExpiry = validLots.length > 0
    ? Math.min(...validLots.map(([, l]) => l.expiresAt))
    : null;
  return { freeRemaining, totalPoints, pointReports, nearestExpiry, freeLimit: FREE_LIMIT, unlimited: false };
}

// 참고 환불액 계산 (getAcademyPointLots와 동일 로직 — 밀리초 기준)
function _refundAmount(lot, now) {
  const within7days = (now - (lot.purchasedAt || 0)) <= 7 * 24 * 3600 * 1000;
  const isUnused  = lot.remaining === lot.total && !lot.revokedAt;
  const isExpired = (lot.expiresAt || 0) <= now;
  const isRevoked = !!lot.revokedAt;
  if (!isRevoked && isUnused && !isExpired) {
    return within7days ? lot.amount : Math.floor(lot.amount * 0.9);
  }
  return 0;
}

// 결제 검증 순수 함수 (_checkPointPayment와 동일 로직)
function _checkPointPayment(payment, order) {
  const product = POINT_PRODUCTS[order.productId];
  if (!product) return { ok: false, reason: `unknown_product:${order.productId}` };
  if (payment.status !== 'PAID') return { ok: false, reason: `status_not_paid:${payment.status}` };
  const paidAmount = payment.amount?.total ?? payment.amount;
  if (paidAmount !== product.amount) {
    return { ok: false, reason: `amount_mismatch:expected=${product.amount},actual=${paidAmount}` };
  }
  if (payment.currency !== 'KRW') return { ok: false, reason: `currency_mismatch:${payment.currency}` };
  return { ok: true };
}

// ── 테스트 러너 ───────────────────────────────────────────────────────
const NOW   = Date.now();
const MONTH = '2026-10';
const results = [];

function test(label, fn) {
  try { fn(); results.push({ label, ok: true }); }
  catch (e) { results.push({ label, ok: false, err: e.message }); }
}

// ─────────────────────────────────────────────────────────────────────
// 무료 크레딧
// ─────────────────────────────────────────────────────────────────────

test('① 첫 사용: freeUsed 0→1, usedFrom free', () => {
  const r = _reserveCredit(null, NOW, MONTH);
  assert.ok(r, '결과가 null이면 안됨');
  assert.strictEqual(r.usedFrom, 'free');
  assert.strictEqual(r.next.freeUsed, 1);
  assert.strictEqual(r.next.month, MONTH);
});

test('② 무료 30건 → 31건째 lot 100P 차감', () => {
  let state = null;
  for (let i = 0; i < FREE_LIMIT; i++) {
    const r = _reserveCredit(state, NOW, MONTH);
    assert.ok(r, `${i + 1}번째 사용에서 null`);
    state = r.next;
  }
  assert.strictEqual(state.freeUsed, FREE_LIMIT);

  // lot 없으면 null
  const rNull = _reserveCredit(state, NOW, MONTH);
  assert.strictEqual(rNull, null, '무료 소진, lot 없으면 null이어야 함');

  // lot 추가 후 31번째 = 100P 차감
  const stateWithLot = {
    ...state,
    lots: { L1: { remaining: 500, expiresAt: NOW + 86400000, revokedAt: null, total: 500 } },
  };
  const r31 = _reserveCredit(stateWithLot, NOW, MONTH);
  assert.ok(r31, '31번째: lot 있으면 null이면 안됨');
  assert.ok(Array.isArray(r31.usedFrom), 'usedFrom은 배열이어야 함');
  assert.strictEqual(r31.next.lots.L1.remaining, 400, 'lot.remaining 500→400');
});

// ─────────────────────────────────────────────────────────────────────
// lot 선택 순서
// ─────────────────────────────────────────────────────────────────────

test('③ lot 여러 개 → expiresAt 빠른 것부터', () => {
  const state = {
    month: MONTH, freeUsed: FREE_LIMIT,
    lots: {
      L_later:  { remaining: 500, expiresAt: NOW + 200000000, revokedAt: null, total: 500 },
      L_sooner: { remaining: 500, expiresAt: NOW + 100000000, revokedAt: null, total: 500 },
    },
  };
  const r = _reserveCredit(state, NOW, MONTH);
  assert.ok(r, 'lot 있으니 null 아님');
  assert.strictEqual(r.usedFrom[0].lotId, 'L_sooner', 'expiresAt 빠른 L_sooner 먼저');
  assert.strictEqual(r.next.lots.L_sooner.remaining, 400);
  assert.strictEqual(r.next.lots.L_later.remaining,  500);
});

test('④ 만료된 lot 제외', () => {
  const state = {
    month: MONTH, freeUsed: FREE_LIMIT,
    lots: { L1: { remaining: 500, expiresAt: NOW - 1000, revokedAt: null, total: 500 } },
  };
  const r = _reserveCredit(state, NOW, MONTH);
  assert.strictEqual(r, null, '만료된 lot만 있으면 null');
});

test('⑤ 회수된 lot 제외', () => {
  const state = {
    month: MONTH, freeUsed: FREE_LIMIT,
    lots: { L1: { remaining: 500, expiresAt: NOW + 86400000, revokedAt: NOW - 1000, total: 500 } },
  };
  const r = _reserveCredit(state, NOW, MONTH);
  assert.strictEqual(r, null, '회수된 lot만 있으면 null');
});

// ─────────────────────────────────────────────────────────────────────
// 여러 lot에 걸친 차감
// ─────────────────────────────────────────────────────────────────────

test('⑥ 한 건이 두 lot에 걸쳐 차감 (60P + 40P = 100P)', () => {
  const state = {
    month: MONTH, freeUsed: FREE_LIMIT,
    lots: {
      L_early: { remaining: 60, expiresAt: NOW + 100000000, revokedAt: null, total: 200 },
      L_late:  { remaining: 200, expiresAt: NOW + 200000000, revokedAt: null, total: 200 },
    },
  };
  const r = _reserveCredit(state, NOW, MONTH);
  assert.ok(r, 'null이면 안됨');
  assert.strictEqual(r.usedFrom.length, 2, '두 lot에서 차감');
  const early = r.usedFrom.find(d => d.lotId === 'L_early');
  const late  = r.usedFrom.find(d => d.lotId === 'L_late');
  assert.strictEqual(early.points, 60, 'L_early 60P');
  assert.strictEqual(late.points,  40, 'L_late 40P');
  assert.strictEqual(early.points + late.points, POINTS_PER_REPORT, '합계 100P');
  assert.strictEqual(r.next.lots.L_early.remaining, 0);
  assert.strictEqual(r.next.lots.L_late.remaining, 160);
});

// ─────────────────────────────────────────────────────────────────────
// 환불 (AI 실패 시 복구)
// ─────────────────────────────────────────────────────────────────────

test('⑦ 환불: free 차감 복구', () => {
  const state = { month: MONTH, freeUsed: 5, lots: {} };
  const next = _refundCredit(state, 'free', MONTH);
  assert.strictEqual(next.freeUsed, 4, 'freeUsed 5→4');
});

test('⑦ 환불: lot 차감 복구 (단일 lot)', () => {
  const state = {
    month: MONTH, freeUsed: FREE_LIMIT,
    lots: { L1: { remaining: 400, expiresAt: NOW + 86400000, revokedAt: null, total: 500 } },
  };
  const next = _refundCredit(state, [{ lotId: 'L1', points: 100 }], MONTH);
  assert.strictEqual(next.lots.L1.remaining, 500, 'lot remaining 400→500');
});

test('⑦ 환불: 두 lot에 걸친 차감 정확히 복구', () => {
  const state = {
    month: MONTH, freeUsed: FREE_LIMIT,
    lots: {
      L_early: { remaining: 0,   expiresAt: NOW + 100000000, revokedAt: null, total: 200 },
      L_late:  { remaining: 160, expiresAt: NOW + 200000000, revokedAt: null, total: 200 },
    },
  };
  const usedFrom = [{ lotId: 'L_early', points: 60 }, { lotId: 'L_late', points: 40 }];
  const next = _refundCredit(state, usedFrom, MONTH);
  assert.strictEqual(next.lots.L_early.remaining, 60,  'L_early 0→60 복구');
  assert.strictEqual(next.lots.L_late.remaining,  200, 'L_late 160→200 복구');
});

// ─────────────────────────────────────────────────────────────────────
// 포인트 부족
// ─────────────────────────────────────────────────────────────────────

test('⑧ 포인트 부족: lot remaining 60P만 있으면 null', () => {
  const state = {
    month: MONTH, freeUsed: FREE_LIMIT,
    lots: { L1: { remaining: 60, expiresAt: NOW + 86400000, revokedAt: null, total: 200 } },
  };
  const r = _reserveCredit(state, NOW, MONTH);
  assert.strictEqual(r, null, '60P < 100P이므로 null');
});

// ─────────────────────────────────────────────────────────────────────
// 달 바뀜
// ─────────────────────────────────────────────────────────────────────

test('⑨ 달 바뀌면 freeUsed 초기화 + 무료 사용 가능', () => {
  const state = {
    month: '2026-09', freeUsed: FREE_LIMIT,
    lots: {},
  };
  const r = _reserveCredit(state, NOW, MONTH);
  assert.ok(r, '달 바뀌면 freeUsed 리셋 후 사용 가능');
  assert.strictEqual(r.usedFrom, 'free');
  assert.strictEqual(r.next.freeUsed, 1);
  assert.strictEqual(r.next.month, MONTH);
});

// ─────────────────────────────────────────────────────────────────────
// 참고 환불액 계산
// ─────────────────────────────────────────────────────────────────────

test('⑩-A 참고 환불액: 7일 이내 + 하나도 안 씀 → 결제액 전액', () => {
  const purchasedAt = NOW - 3 * 86400000; // 3일 전
  const lot = {
    amount: 10000, paidPoints: 10000, bonusPoints: 0, total: 10000, remaining: 10000,
    purchasedAt, expiresAt: purchasedAt + 365 * 86400000, revokedAt: null,
  };
  assert.strictEqual(_refundAmount(lot, NOW), 10000, '전액 환불');
});

test('⑩-B 참고 환불액: 7일 초과 + 하나도 안 씀 + 만료 전 → 90%', () => {
  const purchasedAt = NOW - 10 * 86400000; // 10일 전
  const lot = {
    amount: 10000, paidPoints: 10000, bonusPoints: 0, total: 10000, remaining: 10000,
    purchasedAt, expiresAt: purchasedAt + 365 * 86400000, revokedAt: null,
  };
  assert.strictEqual(_refundAmount(lot, NOW), 9000, '90% 환불');
});

test('⑩-C 참고 환불액: 일부 사용 → 0', () => {
  const purchasedAt = NOW - 2 * 86400000; // 2일 전
  const lot = {
    amount: 10000, paidPoints: 10000, bonusPoints: 0, total: 10000, remaining: 9900,
    purchasedAt, expiresAt: purchasedAt + 365 * 86400000, revokedAt: null,
  };
  assert.strictEqual(_refundAmount(lot, NOW), 0, '일부 사용 → 0');
});

// ─────────────────────────────────────────────────────────────────────
// 30,000원 보너스 계산
// ─────────────────────────────────────────────────────────────────────

test('⑪ p30000 상품: 30,000P + 보너스 3,000P = 33,000P', () => {
  const p = POINT_PRODUCTS.p30000;
  assert.strictEqual(p.amount,      30000);
  assert.strictEqual(p.paidPoints,  30000);
  assert.strictEqual(p.bonusPoints, 3000);
  assert.strictEqual(p.total,       33000);
});

test('⑪ p30000 lot 1회 차감: remaining 33000→32900', () => {
  const state = {
    month: MONTH, freeUsed: FREE_LIMIT,
    lots: { L1: { remaining: 33000, expiresAt: NOW + 86400000, revokedAt: null, total: 33000 } },
  };
  const r = _reserveCredit(state, NOW, MONTH);
  assert.ok(r, 'null이면 안됨');
  assert.strictEqual(r.next.lots.L1.remaining, 32900);
});

// ─────────────────────────────────────────────────────────────────────
// 멱등 적립 확인 (_creditPointLot 로직은 DB 의존이라 순수함수만 검증)
// ─────────────────────────────────────────────────────────────────────

test('⑫ _computeCreditsInfo: lot 있을 때 totalPoints·pointReports·nearestExpiry 반환', () => {
  const lot1expiry = NOW + 100000000;
  const lot2expiry = NOW + 200000000;
  const state = {
    month: MONTH, freeUsed: 10,
    lots: {
      L1: { remaining: 500, expiresAt: lot1expiry, revokedAt: null },
      L2: { remaining: 300, expiresAt: lot2expiry, revokedAt: null },
    },
  };
  const info = _computeCreditsInfo(state, NOW, MONTH);
  assert.strictEqual(info.freeRemaining, 20);
  assert.strictEqual(info.totalPoints,   800);
  assert.strictEqual(info.pointReports,  8);
  assert.strictEqual(info.nearestExpiry, lot1expiry, 'nearestExpiry는 가장 빠른 lot');
  assert.strictEqual(info.unlimited,     false);
});

test('⑫ _computeCreditsInfo: lot 없을 때 nearestExpiry null', () => {
  const state = { month: MONTH, freeUsed: 0, lots: {} };
  const info = _computeCreditsInfo(state, NOW, MONTH);
  assert.strictEqual(info.nearestExpiry, null);
  assert.strictEqual(info.totalPoints,   0);
  assert.strictEqual(info.pointReports,  0);
});

test('⑫ 멱등 보장: 이미 적립된 lot 상태에서 _reserveCredit 재시도 = 동일 차감', () => {
  // 같은 paymentId로 lot이 두 번 추가되면 안 된다는 것을 상태로 검증
  // (실제 DB 적립 멱등은 _creditPointLot이 lotRef.exists() 확인으로 보장)
  const state = {
    month: MONTH, freeUsed: FREE_LIMIT,
    lots: { 'aip_abc': { remaining: 5000, expiresAt: NOW + 86400000, revokedAt: null, total: 5000 } },
  };
  const r1 = _reserveCredit(state, NOW, MONTH);
  const r2 = _reserveCredit(r1.next, NOW, MONTH);
  assert.strictEqual(r1.next.lots['aip_abc'].remaining, 4900, '1차 차감');
  assert.strictEqual(r2.next.lots['aip_abc'].remaining, 4800, '2차 차감 정상');
});

// ─────────────────────────────────────────────────────────────────────
// _checkPointPayment 검증
// ─────────────────────────────────────────────────────────────────────

const OK_PAYMENT = { status: 'PAID', amount: { total: 5000 }, currency: 'KRW' };
const OK_ORDER   = { productId: 'p5000' };

test('⑬ _checkPointPayment: 정상 → ok', () => {
  const r = _checkPointPayment(OK_PAYMENT, OK_ORDER);
  assert.strictEqual(r.ok, true);
});

test('⑬ _checkPointPayment: 금액 적음 → amount_mismatch', () => {
  const r = _checkPointPayment({ ...OK_PAYMENT, amount: { total: 4900 } }, OK_ORDER);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.startsWith('amount_mismatch'), `reason: ${r.reason}`);
});

test('⑬ _checkPointPayment: 금액 많음 → amount_mismatch', () => {
  const r = _checkPointPayment({ ...OK_PAYMENT, amount: { total: 9999 } }, OK_ORDER);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.startsWith('amount_mismatch'), `reason: ${r.reason}`);
});

test('⑬ _checkPointPayment: 통화 다름 → currency_mismatch', () => {
  const r = _checkPointPayment({ ...OK_PAYMENT, currency: 'USD' }, OK_ORDER);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.startsWith('currency_mismatch'), `reason: ${r.reason}`);
});

test('⑬ _checkPointPayment: status PAID 아님 → status_not_paid', () => {
  const r = _checkPointPayment({ ...OK_PAYMENT, status: 'FAILED' }, OK_ORDER);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.startsWith('status_not_paid'), `reason: ${r.reason}`);
});

test('⑬ _checkPointPayment: 알 수 없는 productId → unknown_product', () => {
  const r = _checkPointPayment(OK_PAYMENT, { productId: 'p99999' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.startsWith('unknown_product'), `reason: ${r.reason}`);
});

// ─────────────────────────────────────────────────────────────────────
// 7일 경계 (밀리초 기준)
// ─────────────────────────────────────────────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;

test('⑭ 7일 경계: 정확히 7일(7*24*3600*1000ms) → 전액', () => {
  const purchasedAt = NOW - SEVEN_DAYS_MS; // 정확히 7일 전
  const lot = {
    amount: 10000, total: 10000, remaining: 10000,
    purchasedAt, expiresAt: purchasedAt + 365 * 86400000, revokedAt: null,
  };
  assert.strictEqual(_refundAmount(lot, NOW), 10000, '정확히 7일 = 이내 → 전액');
});

test('⑭ 7일 경계: 7일+1분(7*24*3600*1000+60000ms) → 90%', () => {
  const purchasedAt = NOW - SEVEN_DAYS_MS - 60000; // 7일 + 1분 전
  const lot = {
    amount: 10000, total: 10000, remaining: 10000,
    purchasedAt, expiresAt: purchasedAt + 365 * 86400000, revokedAt: null,
  };
  assert.strictEqual(_refundAmount(lot, NOW), 9000, '7일+1분 = 초과 → 90%');
});

// ── 결과 출력 ──────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
console.log('\n─────────────────────────────────────────');
console.log('AI 크레딧 순수 함수 테스트 (포인트 방식)');
console.log('─────────────────────────────────────────');
console.log('항목                                     결과');
results.forEach(r => {
  const mark = r.ok ? '✅ PASS' : '❌ FAIL';
  console.log(`${mark}  ${r.label}${r.err ? `\n         → ${r.err}` : ''}`);
});
console.log('─────────────────────────────────────────');
console.log(`결과: ${passed}개 통과 / ${failed}개 실패 / 전체 ${results.length}개`);
console.log('─────────────────────────────────────────\n');
process.exit(failed > 0 ? 1 : 0);
