'use strict';
/**
 * test-cancel-addon-flow.js — cancelAddon 위약금 즉시청구 전체 흐름 검증
 *
 * 케이스:
 *  [A] 개별 해지 — 위약금 있음(paidCount=3), 유효 billingKey → PortOne 즉시청구 성공 확인
 *  [B] 개별 해지 — 위약금 있음, 무효 billingKey → PortOne 청구 실패, settlementDue 기록, 해지 완료
 *  [C] 번들 분해(unbundle) — 위약금 있음, 유효 billingKey → 즉시청구 성공, 남은 2개 복원
 *  [D] 개별 해지 — paidCount=0(위약금 0원) → 청구 시도 없이 해지
 *
 * ⚠️ 모든 테스트: test_로 시작하는 academyId만 사용. 실제 고객 학원 절대 건드리지 않음.
 */

const axios = require('./functions/node_modules/axios');
const tools = require('C:/Users/뿌이/.config/configstore/firebase-tools.json');
const AT    = tools.tokens.access_token;

const DB_BASE          = 'https://fillyo-journal-default-rtdb.asia-southeast1.firebasedatabase.app';
const API_KEY          = 'AIzaSyBL5lQr2VIPK9caokm90g4_eQIkA8EXjqE';
const FN_BASE          = 'https://asia-northeast3-fillyo-journal.cloudfunctions.net';
const PORTONE_BASE     = 'https://api.portone.io';
const PORTONE_SECRET   = 't2Y4amXylSFvUYAUgagC6mffRsZzPKHy8sHdFa4P18AYT0HhgJdWNflzL6XgWX9IAleNG6ShF6xuBSxQ';

// INICIS 테스트 채널에서 발급된 고아 빌링키 (테스트 모드, 실제 과금 없음)
const TEST_BILLING_KEY = 'billing-key-019f2375-acc4-51fa-26f2-21f427a4f718';

// ── RTDB 헬퍼 ─────────────────────────────────────────────────────────
const fb = {
  get:    p => axios.get(`${DB_BASE}/${p}.json`,   { params: { access_token: AT } }).then(r => r.data).catch(() => null),
  set:    (p, d) => axios.put(`${DB_BASE}/${p}.json`,    d, { params: { access_token: AT } }).then(r => r.data),
  del:    p => axios.delete(`${DB_BASE}/${p}.json`, { params: { access_token: AT } }).then(r => r.data),
};

// ── PortOne 결제 조회 ───────────────────────────────────────────────────
async function portoneGetPayment(paymentId) {
  try {
    const r = await axios.get(`${PORTONE_BASE}/payments/${encodeURIComponent(paymentId)}`,
      { headers: { Authorization: `PortOne ${PORTONE_SECRET}` } });
    return r.data;
  } catch (e) {
    return { _error: e.response?.data ?? e.message };
  }
}

// ── Firebase Auth 헬퍼 ──────────────────────────────────────────────────
async function createTestUser(email, password) {
  const r = await axios.post(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    { email, password, returnSecureToken: true }
  );
  return { uid: r.data.localId, idToken: r.data.idToken };
}
async function deleteAuthUser(idToken) {
  await axios.post(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${API_KEY}`,
    { idToken }).catch(() => {});
}

// ── Callable 함수 호출 ────────────────────────────────────────────────
async function callFunction(fnName, data, idToken) {
  const r = await axios.post(`${FN_BASE}/${fnName}`, { data }, {
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    timeout: 60000,
  });
  return r.data.result ?? r.data;
}

// ── 유틸 ───────────────────────────────────────────────────────────────
function log(label, obj) {
  console.log('\n' + '─'.repeat(64));
  console.log(`[${label}]`);
  if (obj !== undefined) console.log(JSON.stringify(obj, null, 2));
}
function assert(cond, msg) {
  if (!cond) { console.error(`  ❌ FAIL: ${msg}`); process.exitCode = 1; }
  else        { console.log(`  ✅ OK:   ${msg}`); }
}

// ══════════════════════════════════════════════════════════════════════
async function main() {
  const ts     = Date.now();
  const suffix = ts.toString(36).slice(-6);

  console.log('='.repeat(64));
  console.log('  cancelAddon 위약금 즉시청구 백엔드 검증');
  console.log(`  시작 시각: ${new Date(ts).toISOString()}`);
  console.log(`  테스트 빌링키: ${TEST_BILLING_KEY.slice(0, 35)}...`);
  console.log('='.repeat(64));

  const results = [];

  // ══════════════════════════════════════════════════════════════════════
  //  케이스 A: 개별 해지 — paidCount=3, 유효 billingKey → 즉시청구 성공
  //  위약금 = (9800-4900) × 3 = 14,700원
  // ══════════════════════════════════════════════════════════════════════
  {
    const caseName = 'A: 개별 해지 + 즉시청구 성공 (유효 billingKey, paidCount=3)';
    log(`CASE ${caseName}`);
    const acId  = `test_ca_a_${suffix}`;
    const email = `test_ca_a_${suffix}@test.fillyo.kr`;
    const pass  = `Test1234!${suffix}`;
    let uid, idToken;

    try {
      ({ uid, idToken } = await createTestUser(email, pass));
      console.log(`  학원ID: ${acId} / uid: ${uid}`);

      // 승급심사 1년계약, 3회 결제된 상태로 세팅
      await fb.set(`academies/${acId}`, {
        settings: { academyName: '테스트학원A', phone: '01000000000' },
        billing:  { billingKey: TEST_BILLING_KEY, status: 'active' },
        addons: {
          exam: {
            status: 'active', billingType: 'contract',
            monthlyAmount: 4900, regularAmount: 9800,
            paidCount: 3, currentScheduleId: null,
            subscribedAt: ts - 90 * 24 * 3600 * 1000,
          },
        },
      });
      await fb.set(`users/${uid}`, { academyId: acId, planType: 'pro', email });
      console.log(`  셋업: 승급심사 1년계약, paidCount=3 (위약금 14,700원 예상)`);

      // cancelAddon 실제 호출
      const result = await callFunction('cancelAddon', { academyId: acId, addonKey: 'exam' }, idToken);
      log('cancelAddon 응답', result);

      assert(result?.success === true, '응답: success=true');
      assert(result?.charged === true, '응답: charged=true (즉시청구 성공)');
      assert(result?.amount === 14700,  `응답: amount=14700원 (실제: ${result?.amount})`);

      // RTDB addon 상태 확인
      const addon = await fb.get(`academies/${acId}/addons/exam`);
      assert(addon?.status === 'cancelled', 'RTDB: addon.status=cancelled');

      // RTDB paymentOrders 확인
      const orders = await fb.get('paymentOrders');
      const settlOrders = orders
        ? Object.entries(orders).filter(([k]) => k.startsWith(`addon_settlement_${acId}_exam`))
        : [];
      assert(settlOrders.length > 0, 'RTDB: paymentOrders에 addon_settlement 기록 존재');

      let portoneStatus = null;
      if (settlOrders.length > 0) {
        const [orderId, orderData] = settlOrders[0];
        assert(orderData?.status === 'PAID', `RTDB: paymentOrder.status=PAID (실제: ${orderData?.status})`);

        // PortOne API에서 실제 결제 조회
        const portonePayment = await portoneGetPayment(orderId);
        log('PortOne 결제 조회 결과', portonePayment);
        portoneStatus = portonePayment?.status ?? portonePayment?.payment?.status ?? '조회실패';
        assert(
          portoneStatus === 'PAID' || portonePayment?.payment?.paidAt,
          `PortOne API: 결제 상태 PAID 또는 paidAt 있음 (status=${portoneStatus})`
        );
      }

      results.push({
        케이스: caseName,
        charged: result?.charged,
        amount: result?.amount,
        'RTDB paymentOrder': settlOrders.length > 0 ? '✅ 존재' : '❌ 없음',
        'PortOne 결제': portoneStatus ?? '미확인',
        결과: process.exitCode === 1 ? '❌ 실패' : '✅ 성공',
      });
    } catch (e) {
      console.error(`  ❌ 예외:`, e.response?.data ?? e.message);
      process.exitCode = 1;
      results.push({ 케이스: caseName, 결과: '❌ 예외: ' + (e.response?.data?.error?.message ?? e.message) });
    } finally {
      // paymentOrders 정리
      const orders = await fb.get('paymentOrders');
      if (orders) {
        for (const k of Object.keys(orders)) {
          if (k.startsWith(`addon_settlement_${acId}_`)) await fb.del(`paymentOrders/${k}`);
        }
      }
      await fb.del(`academies/${acId}`);
      await fb.del(`users/${uid}`);
      if (idToken) await deleteAuthUser(idToken);
      console.log('  🧹 정리 완료');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  케이스 B: 개별 해지 — 무효 billingKey → 청구 실패, settlementDue 기록
  //  위약금 = (9800-4900) × 2 = 9,800원
  // ══════════════════════════════════════════════════════════════════════
  {
    const caseName = 'B: 개별 해지 + 청구 실패 (무효 billingKey) → settlementDue';
    log(`CASE ${caseName}`);
    const acId  = `test_ca_b_${suffix}`;
    const email = `test_ca_b_${suffix}@test.fillyo.kr`;
    const pass  = `Test1234!${suffix}`;
    let uid, idToken;

    try {
      ({ uid, idToken } = await createTestUser(email, pass));
      console.log(`  학원ID: ${acId}`);

      await fb.set(`academies/${acId}`, {
        settings: { academyName: '테스트학원B', phone: '01011111111' },
        billing:  { billingKey: 'OBVIOUSLY_INVALID_BILLING_KEY_XYZ', status: 'active' },
        addons: {
          jumprope: {
            status: 'active', billingType: 'contract',
            monthlyAmount: 4900, regularAmount: 9800,
            paidCount: 2, currentScheduleId: null,
          },
        },
      });
      await fb.set(`users/${uid}`, { academyId: acId, planType: 'pro', email });
      console.log(`  셋업: 줄넘기 1년계약, paidCount=2, billingKey=무효`);

      const result = await callFunction('cancelAddon', { academyId: acId, addonKey: 'jumprope' }, idToken);
      log('cancelAddon 응답', result);

      assert(result?.success === true,    '응답: success=true (해지 완료)');
      assert(result?.charged === false,   '응답: charged=false (청구 실패)');
      assert(result?.pendingAmount === 9800, `응답: pendingAmount=9800 (실제: ${result?.pendingAmount})`);

      // addon 해지 완료 확인
      const addon = await fb.get(`academies/${acId}/addons/jumprope`);
      assert(addon?.status === 'cancelled', 'RTDB: addon.status=cancelled (해지 완료)');

      // settlementDue 기록 확인
      const due = await fb.get('settlementDue');
      const dueEntries = due
        ? Object.entries(due).filter(([k]) => k.startsWith(`${acId}_jumprope`))
        : [];
      assert(dueEntries.length > 0, 'RTDB: settlementDue 기록 존재');
      if (dueEntries.length > 0) {
        const [dueKey, dueData] = dueEntries[0];
        log('settlementDue 기록', dueData);
        assert(dueData?.amount === 9800,         `settlementDue.amount=9800 (실제: ${dueData?.amount})`);
        assert(dueData?.academyName === '테스트학원B', `settlementDue.academyName 정확 (실제: ${dueData?.academyName})`);
        assert(dueData?.addonName === '줄넘기',   `settlementDue.addonName=줄넘기 (실제: ${dueData?.addonName})`);
        assert(!!dueData?.reason,                `settlementDue.reason 있음 (실제: ${dueData?.reason})`);
      }

      results.push({
        케이스: caseName,
        charged: result?.charged,
        pendingAmount: result?.pendingAmount,
        settlementDue: dueEntries.length > 0 ? '✅ 기록됨' : '❌ 없음',
        결과: process.exitCode === 1 ? '❌ 실패' : '✅ 성공',
      });
    } catch (e) {
      console.error(`  ❌ 예외:`, e.response?.data ?? e.message);
      process.exitCode = 1;
      results.push({ 케이스: caseName, 결과: '❌ 예외: ' + (e.response?.data?.error?.message ?? e.message) });
    } finally {
      const due = await fb.get('settlementDue');
      if (due) {
        for (const k of Object.keys(due)) {
          if (k.startsWith(`${acId}_`)) await fb.del(`settlementDue/${k}`);
        }
      }
      await fb.del(`academies/${acId}`);
      await fb.del(`users/${uid}`);
      if (idToken) await deleteAuthUser(idToken);
      console.log('  🧹 정리 완료');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  케이스 C: 번들 분해(unbundle) — 3종 묶음에서 exam 제거
  //  bundle.paidCount=2, exam.frozenPaidCount=1 → totalPaid=3
  //  위약금 = (9800-4900) × 3 = 14,700원
  // ══════════════════════════════════════════════════════════════════════
  {
    const caseName = 'C: 번들 분해(unbundle) + 즉시청구 성공';
    log(`CASE ${caseName}`);
    const acId  = `test_ca_c_${suffix}`;
    const email = `test_ca_c_${suffix}@test.fillyo.kr`;
    const pass  = `Test1234!${suffix}`;
    let uid, idToken;

    try {
      ({ uid, idToken } = await createTestUser(email, pass));
      console.log(`  학원ID: ${acId}`);

      await fb.set(`academies/${acId}`, {
        settings: { academyName: '테스트학원C', phone: '01022222222' },
        billing:  { billingKey: TEST_BILLING_KEY, status: 'active' },
        addons: {
          bundle: {
            status: 'active', billingType: 'contract',
            monthlyAmount: 13500, regularAmount: 13500,
            paidCount: 2, currentScheduleId: null,  // null → PortOne 스케줄 취소 생략
            subscribedAt: ts - 60 * 24 * 3600 * 1000,
          },
          exam:     { status: 'merged', frozenPaidCount: 1 },
          jumprope: { status: 'merged', frozenPaidCount: 1 },
          report:   { status: 'merged', frozenPaidCount: 1 },
        },
      });
      await fb.set(`users/${uid}`, { academyId: acId, planType: 'pro', email });
      console.log(`  셋업: 3종 번들 active, bundle.paidCount=2, exam.frozenPaidCount=1`);
      console.log(`         exam 제거 → 위약금 (9800-4900)×3=14,700원 예상`);

      const result = await callFunction('cancelAddon', { academyId: acId, addonKey: 'exam' }, idToken);
      log('cancelAddon 응답', result);

      assert(result?.ok === true,          '응답: ok=true');
      assert(result?.unbundled === true,   '응답: unbundled=true');
      assert(result?.removedKey === 'exam','응답: removedKey=exam');
      assert(result?.charged === true,     '응답: charged=true (즉시청구 성공)');
      assert(result?.amount === 14700,     `응답: amount=14700 (실제: ${result?.amount})`);

      // exam → cancelled
      const examAddon = await fb.get(`academies/${acId}/addons/exam`);
      assert(examAddon?.status === 'cancelled', 'RTDB: exam.status=cancelled');

      // bundle → dissolved
      const bundleAddon = await fb.get(`academies/${acId}/addons/bundle`);
      assert(bundleAddon?.status === 'dissolved', 'RTDB: bundle.status=dissolved');

      // jumprope, report → active (복원)
      const jumpAddon   = await fb.get(`academies/${acId}/addons/jumprope`);
      const reportAddon = await fb.get(`academies/${acId}/addons/report`);
      assert(jumpAddon?.status   === 'active', 'RTDB: jumprope.status=active (복원됨)');
      assert(reportAddon?.status === 'active', 'RTDB: report.status=active (복원됨)');

      // paymentOrders에 addon_settlement 기록
      const orders = await fb.get('paymentOrders');
      const settlOrders = orders
        ? Object.entries(orders).filter(([k]) => k.startsWith(`addon_settlement_${acId}_exam`))
        : [];
      assert(settlOrders.length > 0, 'RTDB: paymentOrders에 addon_settlement 기록 존재');

      let portoneStatus = null;
      if (settlOrders.length > 0) {
        const [orderId, orderData] = settlOrders[0];
        assert(orderData?.status === 'PAID', `RTDB: paymentOrder.status=PAID (실제: ${orderData?.status})`);

        // PortOne API 직접 조회
        const portonePayment = await portoneGetPayment(orderId);
        log('PortOne 결제 조회', portonePayment);
        portoneStatus = portonePayment?.status ?? portonePayment?.payment?.status;
        assert(
          portoneStatus === 'PAID' || portonePayment?.payment?.paidAt,
          `PortOne API: PAID 또는 paidAt 있음 (status=${portoneStatus})`
        );
      }

      results.push({
        케이스: caseName,
        charged: result?.charged,
        amount: result?.amount,
        'RTDB paymentOrder': settlOrders.length > 0 ? '✅ 존재' : '❌ 없음',
        'PortOne 결제': portoneStatus ?? '미확인',
        결과: process.exitCode === 1 ? '❌ 실패' : '✅ 성공',
      });
    } catch (e) {
      console.error(`  ❌ 예외:`, e.response?.data ?? e.message);
      process.exitCode = 1;
      results.push({ 케이스: caseName, 결과: '❌ 예외: ' + (e.response?.data?.error?.message ?? e.message) });
    } finally {
      const orders = await fb.get('paymentOrders');
      if (orders) {
        for (const k of Object.keys(orders)) {
          if (k.includes(acId)) await fb.del(`paymentOrders/${k}`);
        }
      }
      await fb.del(`academies/${acId}`);
      await fb.del(`users/${uid}`);
      if (idToken) await deleteAuthUser(idToken);
      console.log('  🧹 정리 완료');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  케이스 D: 개별 해지 — paidCount=0 → 위약금 0원, 청구 없이 해지
  // ══════════════════════════════════════════════════════════════════════
  {
    const caseName = 'D: 위약금 0원 해지 (paidCount=0, 방금 신청)';
    log(`CASE ${caseName}`);
    const acId  = `test_ca_d_${suffix}`;
    const email = `test_ca_d_${suffix}@test.fillyo.kr`;
    const pass  = `Test1234!${suffix}`;
    let uid, idToken;

    try {
      ({ uid, idToken } = await createTestUser(email, pass));
      console.log(`  학원ID: ${acId}`);

      await fb.set(`academies/${acId}`, {
        settings: { academyName: '테스트학원D', phone: '01033333333' },
        billing:  { billingKey: TEST_BILLING_KEY, status: 'active' },
        addons: {
          report: {
            status: 'active', billingType: 'contract',
            monthlyAmount: 4900, regularAmount: 9800,
            paidCount: 0, currentScheduleId: null,
          },
        },
      });
      await fb.set(`users/${uid}`, { academyId: acId, planType: 'pro', email });
      console.log(`  셋업: AI성장리포트 1년계약, paidCount=0 (위약금 없음)`);

      const result = await callFunction('cancelAddon', { academyId: acId, addonKey: 'report' }, idToken);
      log('cancelAddon 응답', result);

      assert(result?.success === true,  '응답: success=true');
      assert(result?.charged === true,  '응답: charged=true (위약금 0원 → 청구 불필요)');
      assert(result?.amount === 0,      `응답: amount=0 (실제: ${result?.amount})`);

      const addon = await fb.get(`academies/${acId}/addons/report`);
      assert(addon?.status === 'cancelled', 'RTDB: addon.status=cancelled');

      // settlementDue 기록이 없어야 함
      const due = await fb.get('settlementDue');
      const dueEntries = due
        ? Object.entries(due).filter(([k]) => k.startsWith(`${acId}_report`))
        : [];
      assert(dueEntries.length === 0, 'RTDB: settlementDue 기록 없음 (위약금 0원)');

      // paymentOrders에도 addon_settlement 없어야 함
      const orders = await fb.get('paymentOrders');
      const settlOrders = orders
        ? Object.entries(orders).filter(([k]) => k.startsWith(`addon_settlement_${acId}`))
        : [];
      assert(settlOrders.length === 0, 'RTDB: paymentOrders에 addon_settlement 기록 없음');

      results.push({
        케이스: caseName,
        charged: result?.charged,
        amount: result?.amount,
        settlementDue: '✅ 없음 (정상)',
        결과: '✅ 성공',
      });
    } catch (e) {
      console.error(`  ❌ 예외:`, e.response?.data ?? e.message);
      process.exitCode = 1;
      results.push({ 케이스: caseName, 결과: '❌ 예외: ' + (e.response?.data?.error?.message ?? e.message) });
    } finally {
      await fb.del(`academies/${acId}`);
      await fb.del(`users/${uid}`);
      if (idToken) await deleteAuthUser(idToken);
      console.log('  🧹 정리 완료');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  최종 결과 표
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(64));
  console.log('  최종 결과 요약');
  console.log('='.repeat(64));
  console.table(results);

  if (process.exitCode === 1) {
    console.log('\n  ❌ 일부 테스트 실패 — 위 로그 확인 필요');
  } else {
    console.log('\n  ✅ 모든 테스트 통과');
  }
}

main().catch(e => {
  console.error('치명적 오류:', e);
  process.exit(1);
});
