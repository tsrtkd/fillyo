'use strict';
/**
 * AI 크레딧 순수 함수 테스트
 * 실행: node functions/test_credits.js
 *
 * _reserveCredit / _refundCredit 을 인라인으로 재정의해 독립 실행.
 * (index.js export 없이도 동작)
 */

const assert = require('assert');

// ── 순수 함수 (functions/index.js와 동일하게 유지) ─────────────────────
const FREE_LIMIT = 30;

function _reserveCredit(current, now, monthKey) {
  let s = current
    ? { month: current.month, freeUsed: current.freeUsed || 0, packs: current.packs ? { ...current.packs } : {} }
    : { month: monthKey, freeUsed: 0, packs: {} };
  if (s.month !== monthKey) { s.month = monthKey; s.freeUsed = 0; }
  if (s.freeUsed < FREE_LIMIT) {
    return { next: { ...s, freeUsed: s.freeUsed + 1 }, usedFrom: 'free' };
  }
  const validPacks = Object.entries(s.packs)
    .filter(([, p]) => p.remaining > 0 && p.expiresAt > now)
    .sort(([, a], [, b]) => a.expiresAt - b.expiresAt);
  if (validPacks.length > 0) {
    const [packId, pack] = validPacks[0];
    return { next: { ...s, packs: { ...s.packs, [packId]: { ...pack, remaining: pack.remaining - 1 } } }, usedFrom: packId };
  }
  return null;
}

function _refundCredit(current, usedFrom, monthKey) {
  if (!current) return current;
  const s = { month: current.month, freeUsed: current.freeUsed || 0, packs: current.packs ? { ...current.packs } : {} };
  if (usedFrom === 'free') {
    if (s.month === monthKey) s.freeUsed = Math.max(0, s.freeUsed - 1);
  } else {
    const pack = s.packs[usedFrom];
    if (pack) s.packs[usedFrom] = { ...pack, remaining: pack.remaining + 1 };
  }
  return s;
}

// ── 테스트 러너 ───────────────────────────────────────────────────────
const NOW   = Date.now();
const MONTH = '2026-10';
const results = [];

function test(label, fn) {
  try { fn(); results.push({ label, ok: true }); }
  catch (e) { results.push({ label, ok: false, err: e.message }); }
}

// ① 첫 사용: freeUsed 0 → 1
test('① 첫 사용 freeRemaining 30→29', () => {
  const r = _reserveCredit(null, NOW, MONTH);
  assert.ok(r, '결과가 null이면 안됨');
  assert.strictEqual(r.usedFrom, 'free');
  assert.strictEqual(r.next.freeUsed, 1);
  assert.strictEqual(r.next.month, MONTH);
});

// ② 30건 다 쓰면 null
test('② 30건 다 쓰면 null', () => {
  let state = null;
  for (let i = 0; i < FREE_LIMIT; i++) {
    const r = _reserveCredit(state, NOW, MONTH);
    assert.ok(r, `${i + 1}번째 사용에서 null`);
    state = r.next;
  }
  const r = _reserveCredit(state, NOW, MONTH);
  assert.strictEqual(r, null, '30건 소진 후에는 null이어야 함');
});

// ③ 무료 소진 후 pack 차감
test('③ 무료 소진 후 pack 차감', () => {
  const state = {
    month: MONTH, freeUsed: FREE_LIMIT,
    packs: { pk1: { total: 5, remaining: 5, purchasedAt: NOW, expiresAt: NOW + 86400000, paymentId: 'p1' } },
  };
  const r = _reserveCredit(state, NOW, MONTH);
  assert.ok(r, 'pack이 있으면 null 아님');
  assert.strictEqual(r.usedFrom, 'pk1');
  assert.strictEqual(r.next.packs.pk1.remaining, 4);
});

// ④ 만료된 pack은 사용 불가
test('④ 만료된 pack은 안 씀', () => {
  const state = {
    month: MONTH, freeUsed: FREE_LIMIT,
    packs: { pk1: { total: 5, remaining: 5, purchasedAt: NOW, expiresAt: NOW - 1000, paymentId: 'p1' } },
  };
  const r = _reserveCredit(state, NOW, MONTH);
  assert.strictEqual(r, null, '만료된 pack만 있으면 null이어야 함');
});

// ⑤ expiresAt 빠른 pack 먼저
test('⑤ expiresAt 빠른 pack 먼저', () => {
  const state = {
    month: MONTH, freeUsed: FREE_LIMIT,
    packs: {
      pk_later:  { total: 5, remaining: 5, purchasedAt: NOW, expiresAt: NOW + 200000000, paymentId: 'p2' },
      pk_sooner: { total: 5, remaining: 5, purchasedAt: NOW, expiresAt: NOW + 100000000, paymentId: 'p1' },
    },
  };
  const r = _reserveCredit(state, NOW, MONTH);
  assert.ok(r, 'pack 있으니 null 아님');
  assert.strictEqual(r.usedFrom, 'pk_sooner', 'expiresAt 빠른 pk_sooner를 먼저 써야 함');
});

// ⑥ 달이 바뀌면 freeUsed 초기화
test('⑥ 달이 바뀌면 freeUsed 초기화', () => {
  const state = { month: '2026-09', freeUsed: FREE_LIMIT, packs: {} };
  const r = _reserveCredit(state, NOW, MONTH);
  assert.ok(r, 'freeUsed 리셋 후 사용 가능해야 함');
  assert.strictEqual(r.usedFrom, 'free');
  assert.strictEqual(r.next.freeUsed, 1);
  assert.strictEqual(r.next.month, MONTH, '월키가 새 월로 갱신되어야 함');
});

// ⑦ 환불: free 차감 복구
test('⑦ 환불: free 차감 복구', () => {
  const state = { month: MONTH, freeUsed: 5, packs: {} };
  const next = _refundCredit(state, 'free', MONTH);
  assert.strictEqual(next.freeUsed, 4, 'freeUsed가 1 감소해야 함');
});

// ⑦ 환불: pack 차감 복구
test('⑦ 환불: pack 차감 복구', () => {
  const state = {
    month: MONTH, freeUsed: FREE_LIMIT,
    packs: { pk1: { total: 5, remaining: 4, purchasedAt: NOW, expiresAt: NOW + 86400000, paymentId: 'p1' } },
  };
  const next = _refundCredit(state, 'pk1', MONTH);
  assert.strictEqual(next.packs.pk1.remaining, 5, 'pack remaining이 1 증가해야 함');
});

// ── 결과 출력 ──────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
console.log('\n─────────────────────────────────────────');
console.log('AI 크레딧 순수 함수 테스트');
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
