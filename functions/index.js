'use strict';

const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin   = require('firebase-admin');
const axios   = require('axios');
const cors    = require('cors')({ origin: true });
const PortOne = require('@portone/server-sdk');

admin.initializeApp();
const db = admin.database();

const PORTONE_BASE = 'https://api.portone.io';

// ⚠️⚠️⚠️ 매우 중요 - 테스트 작성 규칙 ⚠️⚠️⚠️
// 이 파일의 함수를 테스트할 땐 반드시 위에 정의된 실제 함수(exports.xxx)를
// 그대로 import해서 호출할 것.
// 절대로 별도의 스크립트에서 axios로 PortOne API를 직접 재구현하거나,
// Firebase Admin SDK로 DB를 직접 조작해서 "비슷하게" 테스트하지 말 것.
// 그렇게 하면 아래 안전장치(assertNotProtectedForTest)를 우회하게 되어
// 실제 고객 데이터가 위험해짐. (2026-07-06 사고 참고)

const PROTECTED_ACADEMY_IDS = ['ac_mq2avp88kwmd', 'ac_mqeizbqcgyxo'];
// 태사랑태권도, 오류교회 - 실제 가입 고객. 테스트 절대 금지.

function assertNotProtectedForTest(academyId, context) {
  if (PROTECTED_ACADEMY_IDS.includes(academyId)) {
    throw new Error(
      `[안전장치] ${academyId}는 보호된 실제 고객 학원입니다. ` +
      `${context} 작업이 여기서 강제 차단되었습니다. ` +
      `테스트가 필요하면 반드시 test_로 시작하는 새 academyId를 만들어서 하세요.`
    );
  }
}

function apiSecret() {
  return process.env.PORTONE_API_SECRET;
}

// ── 애드온 가격표 ──────────────────────────────────────────────────
// 유료 애드온은 AI성장리포트 하나. 줄넘기·승급심사는 포함됨.
// billingType: 'contract'(1년 계약) 전용
// regularAmount: 정가 → 중도해지 위약금 계산용
const ADDON_PRICE_TABLE = {
  report: { regularAmount: 19800, name: 'AI성장리포트 (줄넘기·승급심사 포함)' },
};

// AI성장리포트 가격 단계 (수동 전환 — 대표님 지시 시에만 변경)
// 'earlybird': 9,900원 / 'discount30': 13,500원 / 'full': 19,800원
// ※ 전환 조건: ADDON_LIVE_DATE 기준 최소 3개월 이상 경과 후 다음 단계 가능
const ADDON_PRICE_TIER = 'earlybird';

// 얼리버드 시작일 기록용 (가격 전환 자동계산에 사용하지 않음)
// KG이니시스 실연동 전환 시 'YYYY-MM-DD' 형식으로 기입
const ADDON_LIVE_DATE = null;

function reportContractPrice() {
  if (ADDON_PRICE_TIER === 'discount30') return 13500;
  if (ADDON_PRICE_TIER === 'full') return 19800;
  return 9900; // 'earlybird'
}

// 다음 달 동일 일자 계산 (월말 보정 포함)
function nextMonthSameDay(from = new Date()) {
  const d   = new Date(from);
  const day = d.getDate();
  d.setMonth(d.getMonth() + 1);
  // 1월 31일 → 2월 28/29일처럼 월 오버플로 발생 시 해당 달 마지막 날로 보정
  if (d.getDate() !== day) d.setDate(0);
  return d;
}

// ──────────────────────────────────────────────────────────────────
// scheduleNextPayment
// 클라이언트가 빌키 발급 직후 호출 → PortOne 결제 예약 + Firebase 저장
// ──────────────────────────────────────────────────────────────────
exports.scheduleNextPayment = onRequest(
  { region: 'asia-northeast3', timeoutSeconds: 30 },
  (req, res) => {
    cors(req, res, async () => {
      if (req.method === 'OPTIONS') return res.status(204).send('');
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      // Firebase ID 토큰 검증
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        await admin.auth().verifyIdToken(authHeader.slice(7));
      } catch {
        return res.status(401).json({ error: 'Invalid token' });
      }

      const { billingKey, academyId, amount, orderName } = req.body;
      if (!billingKey || !academyId || !amount || !orderName) {
        return res.status(400).json({ error: 'billingKey, academyId, amount, orderName 필수' });
      }
      assertNotProtectedForTest(academyId, 'scheduleNextPayment');

      const paymentId = `sub_${Date.now()}_${academyId}`;
      const timeToPay = nextMonthSameDay();

      try {
        const portoneRes = await axios.post(
          `${PORTONE_BASE}/payments/${paymentId}/schedule`,
          {
            payment: {
              billingKey,
              orderName,
              customer: { id: academyId },
              amount:   { total: amount },
              currency: 'KRW',
            },
            timeToPay: timeToPay.toISOString(),
          },
          { headers: { Authorization: `PortOne ${apiSecret()}`, 'Content-Type': 'application/json' } },
        );

        console.log('[scheduleNextPayment] PortOne 응답:', JSON.stringify(portoneRes.data));

        const scheduleId = portoneRes.data?.scheduleId
          ?? portoneRes.data?.schedule?.id
          ?? portoneRes.data?.schedule?.scheduleId
          ?? null;

        const now = Date.now();

        if (!scheduleId) {
          console.error('[scheduleNextPayment] scheduleId 없음 — 예약 실패 처리:', JSON.stringify(portoneRes.data));
          await db.ref(`paymentOrders/${paymentId}`).set({
            academyId,
            amount,
            orderName,
            billingKey,
            scheduledAt:        now,
            scheduleFailed:     true,
            scheduleFailReason: 'scheduleId 없음',
            portoneResponse:    JSON.stringify(portoneRes.data),
          });
          return res.status(500).json({ error: '결제 예약 실패 (scheduleId 없음)', portoneData: portoneRes.data });
        }

        // academyId별 빌링 정보 저장
        const existingBillingSnap = await db.ref(`academies/${academyId}/billing`).get();
        const existingBilling = existingBillingSnap.val() || {};

        const billingUpdate = {
          billingKey,
          nextPaymentAt:          timeToPay.getTime(),
          lastScheduledPaymentId: paymentId,
          lastScheduledAt:        now,
          paymentFailed:          false,
        };

        // 최초 구독 시점에만 결제 추적 필드 초기화 (이미 값이 있으면 유지)
        // 이 데이터는 중도해지 위약금 = (regularAmount - monthlyAmount) × paidCount 계산에 사용
        // (애드온의 pendingCharge 계산 방식과 동일한 공식)
        if (existingBilling.paidCount === undefined || existingBilling.paidCount === null) {
          billingUpdate.monthlyAmount = amount;   // 실제 납부 금액 (할인가 포함)
          billingUpdate.regularAmount = 19800;    // 업무일지 정가 (고정)
          billingUpdate.paidCount     = 0;        // 최초 가입 시 0으로 초기화
        }

        await db.ref(`academies/${academyId}/billing`).update(billingUpdate);

        // paymentId → academy 매핑 (웹훅 조회용)
        await db.ref(`paymentOrders/${paymentId}`).set({
          academyId,
          amount,
          orderName,
          billingKey,
          scheduledAt:     now,
          scheduleId,
          scheduleStatus:  portoneRes.data?.status ?? portoneRes.data?.schedule?.status ?? null,
          portoneResponse: JSON.stringify(portoneRes.data),
        });

        return res.status(200).json({ ok: true, paymentId, scheduleId, timeToPay: timeToPay.toISOString() });
      } catch (e) {
        console.error('[scheduleNextPayment] PortOne API 오류:', e.response?.data ?? e.message);
        return res.status(500).json({ error: '결제 예약 실패', details: e.response?.data });
      }
    });
  },
);

// ──────────────────────────────────────────────────────────────────
// portoneWebhook
// PortOne 서버가 결제 시도 결과를 POST로 전송하는 엔드포인트
// paymentId가 'addon_' 로 시작하면 애드온 결제 경로로 분기
// ──────────────────────────────────────────────────────────────────
exports.portoneWebhook = onRequest(
  { region: 'asia-northeast3', timeoutSeconds: 30 },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(200).send('ok');

    // PortOne 웹훅 시그니처 검증
    try {
      await PortOne.Webhook.verify(
        process.env.PORTONE_WEBHOOK_SECRET,
        req.rawBody.toString('utf-8'),
        req.headers,
      );
    } catch (e) {
      console.error('[portoneWebhook] 시그니처 검증 실패:', e.message);
      return res.status(400).json({ error: '웹훅 시그니처 검증 실패' });
    }

    // PortOne V2 웹훅 바디에서 paymentId 추출
    const body      = req.body || {};
    const paymentId = body?.data?.paymentId ?? body?.paymentId ?? body?.payment_id;

    if (!paymentId) {
      console.warn('[portoneWebhook] paymentId 없음:', JSON.stringify(body));
      return res.status(200).send('ok');
    }

    try {
      // ① PortOne 단건 조회로 실제 결제 상태 확인 (위변조 방지)
      const { data: payment } = await axios.get(
        `${PORTONE_BASE}/payments/${paymentId}`,
        { headers: { Authorization: `PortOne ${apiSecret()}` } },
      );
      const status = payment.status; // 'PAID' | 'FAILED' | 'CANCELLED' | ...

      // ② Firebase에서 주문 정보 조회
      const orderSnap = await db.ref(`paymentOrders/${paymentId}`).get();
      if (!orderSnap.exists()) {
        console.warn('[portoneWebhook] 주문 정보 없음:', paymentId);
        return res.status(200).send('ok');
      }
      const order = orderSnap.val();
      const { academyId, amount, orderName, billingKey } = order;
      const now = Date.now();

      // ── 애드온 결제 분기 (paymentId 접두사 또는 order.type으로 판별) ──────
      const isAddon = order.type === 'addon' || paymentId.startsWith('addon_');

      if (isAddon) {
        // ────────────────────────────────────────────────────────────
        //  애드온 결제 처리 경로
        // ────────────────────────────────────────────────────────────
        const { addonKey, billingType } = order;

        if (status === 'PAID') {
          // 결제 이력 저장
          await db.ref(`academies/${academyId}/payments/${paymentId}`).set({
            paymentId,
            type:      'addon',
            addonKey,
            status,
            amount:    payment.amount?.total ?? amount,
            orderName,
            paidAt:    now,
          });

          // paidCount 갱신
          const addonSnap  = await db.ref(`academies/${academyId}/addons/${addonKey}`).get();
          const addonData  = addonSnap.val() || {};
          const newPaidCount = (addonData.paidCount || 0) + 1;

          // 다음 달 재예약: contract 타입이고 12회 미만인 경우만
          let nextPaymentId = null;
          let nextScheduleId = null;
          let nextTime = null;

          if (billingType === 'contract' && newPaidCount < 12) {
            nextPaymentId = `addon_${addonKey}_${academyId}_${now}`;
            nextTime = nextMonthSameDay();
            try {
              const reschedResp = await axios.post(
                `${PORTONE_BASE}/payments/${nextPaymentId}/schedule`,
                {
                  payment: {
                    billingKey,
                    orderName,
                    customer: { id: academyId },
                    amount:   { total: amount },
                    currency: 'KRW',
                  },
                  timeToPay: nextTime.toISOString(),
                },
                { headers: { Authorization: `PortOne ${apiSecret()}`, 'Content-Type': 'application/json' } },
              );
              nextScheduleId = reschedResp.data?.scheduleId
                ?? reschedResp.data?.schedule?.id
                ?? reschedResp.data?.schedule?.scheduleId
                ?? null;

              await db.ref(`paymentOrders/${nextPaymentId}`).set({
                type: 'addon',
                academyId,
                addonKey,
                billingType,
                amount,
                orderName,
                billingKey,
                scheduledAt: now,
              });
            } catch (e) {
              console.error('[portoneWebhook][addon] 재예약 실패:', e.response?.data ?? e.message);
            }
          }

          // addon 상태 갱신
          const addonUpdate = {
            paidCount:          newPaidCount,
            lastPaidAt:         now,
            currentPaymentId:   nextPaymentId,
            currentScheduleId:  nextScheduleId,
          };
          if (newPaidCount >= 12) addonUpdate.status = 'completed';
          await db.ref(`academies/${academyId}/addons/${addonKey}`).update(addonUpdate);

        } else {
          // 애드온 결제 실패: 이력 저장 + 실패 플래그
          await db.ref(`academies/${academyId}/payments/${paymentId}`).set({
            paymentId,
            type:       'addon',
            addonKey,
            status,
            amount:     payment.amount?.total ?? amount,
            orderName,
            failReason: payment.failReason || '결제 실패',
            failedAt:   now,
          });
          await db.ref(`academies/${academyId}/addons/${addonKey}`).update({
            lastFailedAt:   now,
            lastFailReason: payment.failReason || '결제 실패',
          });
        }

      } else {
        // ────────────────────────────────────────────────────────────
        //  업무일지(기본 구독) 결제 처리 경로 — 기존 로직 완전 유지
        // ────────────────────────────────────────────────────────────
        if (status === 'PAID') {
          // ③-성공: 결제 이력 저장 + 다음 달 재예약
          await db.ref(`academies/${academyId}/payments/${paymentId}`).set({
            paymentId,
            status,
            amount:    payment.amount?.total ?? amount,
            orderName,
            paidAt:    now,
          });

          // paidCount 갱신 (+1): 중도해지 위약금 계산용 누적 결제 횟수
          // 위약금 = (regularAmount - monthlyAmount) × paidCount (애드온 pendingCharge와 동일 공식)
          const billingSnap  = await db.ref(`academies/${academyId}/billing`).get();
          const billingData  = billingSnap.val() || {};
          const newPaidCount = (billingData.paidCount || 0) + 1;

          await db.ref(`academies/${academyId}/billing`).update({
            paymentFailed: false,
            lastPaidAt:    now,
            paidCount:     newPaidCount,
          });

          // 다음 달 자동 재예약
          const nextId   = `sub_${Date.now()}_${academyId}`;
          const nextTime = nextMonthSameDay();
          await axios.post(
            `${PORTONE_BASE}/payments/${nextId}/schedule`,
            {
              payment: {
                billingKey,
                orderName,
                customer: { id: academyId },
                amount:   { total: amount },
                currency: 'KRW',
              },
              timeToPay: nextTime.toISOString(),
            },
            { headers: { Authorization: `PortOne ${apiSecret()}`, 'Content-Type': 'application/json' } },
          );
          await db.ref(`academies/${academyId}/billing`).update({
            nextPaymentAt:          nextTime.getTime(),
            lastScheduledPaymentId: nextId,
          });
          await db.ref(`paymentOrders/${nextId}`).set({
            academyId, amount, orderName, billingKey,
            scheduledAt: now,
          });

        } else {
          // ③-실패: 실패 이력 저장 + 실패 플래그
          await db.ref(`academies/${academyId}/payments/${paymentId}`).set({
            paymentId,
            status,
            amount:     payment.amount?.total ?? amount,
            orderName,
            failReason: payment.failReason || '결제 실패',
            failedAt:   now,
          });
          await db.ref(`academies/${academyId}/billing`).update({
            paymentFailed: true,
            failReason:    payment.failReason || '결제 실패',
            failedAt:      now,
          });
        }
      }
    } catch (e) {
      // 웹훅은 항상 200 반환 (PortOne 재시도 방지)
      console.error('[portoneWebhook] 처리 오류:', e.response?.data ?? e.message);
    }

    return res.status(200).send('ok');
  },
);

// ──────────────────────────────────────────────────────────────────
// cancelSubscription
// 구독 해지: 결제 예약 취소 → 빌링키 삭제 → Firebase 상태 갱신
// ──────────────────────────────────────────────────────────────────
exports.cancelSubscription = onRequest(
  { region: 'asia-northeast3', timeoutSeconds: 30 },
  (req, res) => {
    cors(req, res, async () => {
      if (req.method === 'OPTIONS') return res.status(204).send('');
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      // Firebase ID 토큰 검증 + uid 추출
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      let uid;
      try {
        const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
        uid = decoded.uid;
      } catch {
        return res.status(401).json({ error: 'Invalid token' });
      }

      const { academyId } = req.body;
      if (!academyId) {
        return res.status(400).json({ error: 'academyId 필수' });
      }
      assertNotProtectedForTest(academyId, 'cancelSubscription');

      // 본인 학원 소유권 확인
      const userSnap = await db.ref(`users/${uid}/academyId`).get();
      if (!userSnap.exists() || userSnap.val() !== academyId) {
        return res.status(403).json({ error: '본인 학원의 구독만 취소할 수 있습니다' });
      }

      // academies/{academyId}/billing에서 billingKey 조회
      const billingSnap = await db.ref(`academies/${academyId}/billing`).get();
      const billing = billingSnap.val() || {};
      const { billingKey } = billing;

      if (!billingKey) {
        return res.status(400).json({ error: '해지할 정기결제가 없습니다' });
      }

      const now = Date.now();

      // ① 결제 예약 전체 취소 (billingKey 기준 일괄)
      try {
        await axios.delete(
          `${PORTONE_BASE}/payment-schedules`,
          {
            headers: { Authorization: `PortOne ${apiSecret()}`, 'Content-Type': 'application/json' },
            data: { billingKey },
          },
        );
      } catch (e) {
        const portoneMsg = e.response?.data?.message ?? e.message;
        console.error('[cancelSubscription] ① 결제 예약 취소 실패:', portoneMsg);
        return res.status(500).json({ error: '결제 예약 취소 실패: ' + portoneMsg });
      }

      // ② 빌링키 삭제
      try {
        await axios.delete(
          `${PORTONE_BASE}/billing-keys/${billingKey}`,
          { headers: { Authorization: `PortOne ${apiSecret()}` } },
        );
      } catch (e) {
        console.error('[cancelSubscription] ② 빌링키 삭제 실패:', e.response?.data ?? e.message);
        return res.status(500).json({ error: '빌링키 삭제 실패', details: e.response?.data });
      }

      // ③ academies/{academyId}/billing에 해지 상태 기록 (billingKey null로 초기화)
      try {
        await db.ref(`academies/${academyId}/billing`).update({
          status:      'cancelled',
          cancelledAt: now,
          billingKey:  null,
        });
      } catch (e) {
        console.error('[cancelSubscription] ③ billing 업데이트 실패:', e.message);
        return res.status(500).json({ error: 'billing 업데이트 실패' });
      }

      // ④ users/{uid}에 해지 상태 기록
      try {
        await db.ref(`users/${uid}`).update({
          planType:    'cancelled',
          cancelledAt: now,
        });
      } catch (e) {
        console.error('[cancelSubscription] ④ users 업데이트 실패:', e.message);
        return res.status(500).json({ error: 'users 업데이트 실패' });
      }

      // ⑤ active 계약 또는 최신 계약에 cancelled 상태 기록
      try {
        const contractsSnap = await db.ref(`academies/${academyId}/contracts`).get();
        if (contractsSnap.exists()) {
          const contracts = contractsSnap.val();
          // active 상태인 계약 우선, 없으면 key 기준 가장 최근 계약
          const activeEntry = Object.entries(contracts).find(([, v]) => v.status === 'active');
          const targetEntry = activeEntry ?? Object.entries(contracts).at(-1);
          if (targetEntry) {
            const [contractId] = targetEntry;
            await db.ref(`academies/${academyId}/contracts/${contractId}`).update({
              status:      'cancelled',
              cancelledAt: now,
            });
          }
        }
      } catch (e) {
        console.error('[cancelSubscription] ⑤ 계약서 업데이트 실패:', e.message);
      }

      return res.status(200).json({ ok: true, cancelledAt: now });
    });
  },
);

// ──────────────────────────────────────────────────────────────────
// subscribeAddon  (Callable)
// 기본 구독(업무일지) 활성 상태에서 애드온을 추가 신청
// 입력: { academyId, addonKey, billingType }
// ──────────────────────────────────────────────────────────────────
exports.subscribeAddon = onCall(
  { region: 'asia-northeast3' },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다');

    const { academyId, addonKey } = request.data;

    // 입력값 검증 (billingType은 항상 'contract' 고정)
    if (!academyId || !addonKey) {
      throw new HttpsError('invalid-argument', 'academyId, addonKey 필수');
    }
    if (addonKey !== 'report') {
      throw new HttpsError('invalid-argument', `알 수 없는 addonKey: ${addonKey}`);
    }
    const priceInfo = ADDON_PRICE_TABLE[addonKey];
    const billingType = 'contract';
    assertNotProtectedForTest(academyId, 'subscribeAddon');

    // 본인 학원 소유권 확인
    const userSnap = await db.ref(`users/${uid}/academyId`).get();
    if (!userSnap.exists() || userSnap.val() !== academyId) {
      throw new HttpsError('permission-denied', '본인 학원만 애드온을 신청할 수 있습니다');
    }

    // 기본 구독(업무일지) 활성 여부 확인: billingKey 유무로 판단
    const billingSnap = await db.ref(`academies/${academyId}/billing`).get();
    const billing     = billingSnap.val() || {};
    if (!billing.billingKey) {
      throw new HttpsError(
        'failed-precondition',
        '업무일지 정기구독이 활성 상태가 아닙니다 (billingKey 없음)',
      );
    }
    const { billingKey } = billing;

    // 금액 결정 (단계별 가격 적용)
    const monthlyAmount = reportContractPrice();
    const regularAmount = priceInfo.regularAmount;
    const orderName     = `FILLYO ${priceInfo.name} 1년 계약`;

    // paymentId: 업무일지(sub_)와 절대 겹치지 않도록 addon_ 접두사 사용
    const timestamp = Date.now();
    const paymentId = `addon_${addonKey}_${academyId}_${timestamp}`;
    const timeToPay = nextMonthSameDay(new Date(timestamp));

    // PortOne 결제 예약
    let scheduleId = null;
    try {
      const schedResp = await axios.post(
        `${PORTONE_BASE}/payments/${paymentId}/schedule`,
        {
          payment: {
            billingKey,
            orderName,
            customer: { id: academyId },
            amount:   { total: monthlyAmount },
            currency: 'KRW',
          },
          timeToPay: timeToPay.toISOString(),
        },
        { headers: { Authorization: `PortOne ${apiSecret()}`, 'Content-Type': 'application/json' } },
      );
      // PortOne V2 응답 구조: { schedule: { id: "schedule-id-..." } }
      scheduleId = schedResp.data?.scheduleId
        ?? schedResp.data?.schedule?.id
        ?? schedResp.data?.schedule?.scheduleId
        ?? null;
    } catch (e) {
      const detail = e.response?.data ?? e.message;
      console.error('[subscribeAddon] PortOne 예약 실패:', detail);
      throw new HttpsError('internal', '결제 예약 실패: ' + JSON.stringify(detail));
    }

    // Firebase 저장: academies/{academyId}/addons/{addonKey}
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
    await db.ref(`academies/${academyId}/addons/${addonKey}`).set(addonData);

    // paymentOrders 저장 (웹훅에서 academyId·addonKey 조회용)
    await db.ref(`paymentOrders/${paymentId}`).set({
      type:       'addon',
      academyId,
      addonKey,
      billingType,
      amount:     monthlyAmount,
      orderName,
      billingKey,
      scheduledAt: timestamp,
    });

    console.log(`[subscribeAddon] 완료: ${academyId}/${addonKey} paymentId=${paymentId} scheduleId=${scheduleId}`);
    return {
      ok:        true,
      paymentId,
      scheduleId,
      timeToPay: timeToPay.toISOString(),
    };
  },
);

// ──────────────────────────────────────────────────────────────────
// chargeAddonPenalty — 애드온 위약금 즉시 청구 (내부 헬퍼)
// 성공: { charged: true }  /  실패 or billingKey 없음: settlementDue 기록 후 { charged: false }
// ──────────────────────────────────────────────────────────────────
async function chargeAddonPenalty({ academyId, addonKey, penalty, billingKey, settings }) {
  if (penalty <= 0) return { charged: true };

  let charged = false;
  let chargeError = null;
  const ts = Date.now();
  const paymentId = `addon_settlement_${academyId}_${addonKey}_${ts}`;
  const addonName = ADDON_PRICE_TABLE[addonKey]?.name ?? addonKey;
  const orderName = `FILLYO ${addonName} 중도해지 정산금`;

  if (billingKey) {
    try {
      const chargeResp = await axios.post(
        `${PORTONE_BASE}/payments/${paymentId}/billing-key`,
        {
          billingKey,
          orderName,
          customer: {
            customerId:  academyId,
            name:        { full: (settings.academyName || settings.name || 'Academy').replace(/[^\x00-\x7F]/g, '').trim() || 'Academy' },
            email:       settings.email || 'noreply@fillyo.kr',
            phoneNumber: (settings.phone || '00000000000').replace(/[^0-9]/g, ''),
          },
          amount:   { total: penalty },
          currency: 'KRW',
        },
        { headers: { Authorization: `PortOne ${apiSecret()}`, 'Content-Type': 'application/json' } },
      );
      const payData   = chargeResp.data?.payment ?? chargeResp.data;
      const payStatus = chargeResp.data?.status ?? payData?.status;
      const isPaid    = payStatus === 'PAID' || (payData?.paidAt && !payData?.failedAt);
      if (isPaid) {
        charged = true;
        await db.ref(`paymentOrders/${paymentId}`).set({
          type:      'addon_settlement',
          academyId,
          addonKey,
          amount:    penalty,
          orderName,
          billingKey,
          status:    'PAID',
          paidAt:    ts,
        });
        console.log(`[chargeAddonPenalty] 청구 성공: ${penalty}원 (${academyId}/${addonKey})`);
      } else {
        chargeError = `결제 상태: ${payStatus ?? JSON.stringify(chargeResp.data)}`;
        console.warn(`[chargeAddonPenalty] 예상치 못한 결제 상태:`, chargeResp.data);
      }
    } catch (e) {
      chargeError = e.response?.data?.message ?? e.message;
      console.error('[chargeAddonPenalty] 즉시 청구 실패:', e.response?.data ?? e.message);
    }
  } else {
    chargeError = 'billingKey 없음 — 카드 정보 없어 청구 불가';
    console.warn(`[chargeAddonPenalty] billingKey 없음 (${academyId}/${addonKey})`);
  }

  if (!charged) {
    await db.ref(`settlementDue/${academyId}_${addonKey}_${ts}`).set({
      academyName: settings.academyName || settings.name || academyId,
      addonName,
      amount:      penalty,
      reason:      chargeError || '청구 실패',
      failedAt:    ts,
    });
    console.log(`[chargeAddonPenalty] settlementDue 기록: ${penalty}원 (${academyId}/${addonKey})`);
  }

  return { charged };
}

// ──────────────────────────────────────────────────────────────────
// cancelAddon  (Callable)
// 특정 애드온 해지 또는 번들에서 하나만 분리
// 입력: { academyId, addonKey }
// ──────────────────────────────────────────────────────────────────
exports.cancelAddon = onCall(
  { region: 'asia-northeast3' },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다');

    const { academyId, addonKey } = request.data;
    if (!academyId || !addonKey) {
      throw new HttpsError('invalid-argument', 'academyId, addonKey 필수');
    }
    assertNotProtectedForTest(academyId, 'cancelAddon');

    // 소유권 확인
    const userSnap = await db.ref(`users/${uid}/academyId`).get();
    if (!userSnap.exists() || userSnap.val() !== academyId) {
      throw new HttpsError('permission-denied', '본인 학원만 애드온을 해지할 수 있습니다');
    }

    // 애드온 데이터 조회
    const addonSnap = await db.ref(`academies/${academyId}/addons/${addonKey}`).get();
    if (!addonSnap.exists()) {
      throw new HttpsError('not-found', `addons/${addonKey} 데이터가 없습니다`);
    }
    const addon = addonSnap.val();

    // billing · settings 조회
    const [billingSnap, settingsSnap] = await Promise.all([
      db.ref(`academies/${academyId}/billing`).get(),
      db.ref(`academies/${academyId}/settings`).get(),
    ]);
    const { billingKey } = billingSnap.val() || {};
    const settings = settingsSnap.val() || {};
    // billingKey 없어도 계속 진행 — 위약금 청구는 실패 처리

    const now = Date.now();

    if (addon.status !== 'active') {
      throw new HttpsError('failed-precondition', '활성 상태의 애드온만 해지할 수 있습니다');
    }

    const paid = addon.paidCount || 0;

    // ── 1년 약정 중도해지: 위약금 즉시 청구 시도
    let penalty = 0;
    let chargeResult = { charged: true };
    if (addon.billingType === 'contract' && paid < 12) {
      penalty = (addon.regularAmount - addon.monthlyAmount) * paid;
      chargeResult = await chargeAddonPenalty({ academyId, addonKey, penalty, billingKey, settings });
    }

    // ── PortOne 예약 취소: 이 애드온의 schedule만 (업무일지 예약은 건드리지 않음)
    if (addon.currentScheduleId) {
      try {
        await axios.delete(
          `${PORTONE_BASE}/payment-schedules`,
          {
            headers: { Authorization: `PortOne ${apiSecret()}`, 'Content-Type': 'application/json' },
            data:    { billingKey, scheduleIds: [addon.currentScheduleId] },
          },
        );
        console.log(`[cancelAddon] PortOne 예약 취소 완료: scheduleId=${addon.currentScheduleId}`);
      } catch (e) {
        const detail = e.response?.data ?? e.message;
        console.error('[cancelAddon] PortOne 예약 취소 실패:', detail);
        throw new HttpsError('internal', '예약 취소 실패: ' + JSON.stringify(detail));
      }
    } else {
      console.warn(`[cancelAddon] currentScheduleId 없음 — 예약 취소 생략 (${academyId}/${addonKey})`);
    }

    // ── addon 상태 업데이트
    await db.ref(`academies/${academyId}/addons/${addonKey}`).update({
      status:      'cancelled',
      cancelledAt: now,
    });

    console.log(`[cancelAddon] 해지 완료: ${academyId}/${addonKey}`);
    return {
      ok:          true,
      cancelledAt: now,
      success:     true,
      charged:     chargeResult.charged,
      ...(chargeResult.charged ? { amount: penalty } : { pendingAmount: penalty }),
    };
  },
);

// ──────────────────────────────────────────────────────────────────
// calculateWithdrawSettlement  (Callable)
// 회원탈퇴 전 위약금(정산 차액) 계산 — 실제 청구는 하지 않음
// 입력: { academyId }
// 반환: { journalPenalty, addonPenalties: [{addonKey, name, amount}], totalPenalty }
// ──────────────────────────────────────────────────────────────────
exports.calculateWithdrawSettlement = onCall(
  { region: 'asia-northeast3' },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다');

    const { academyId } = request.data;
    if (!academyId) throw new HttpsError('invalid-argument', 'academyId 필수');

    // 소유권 확인
    const userSnap = await db.ref(`users/${uid}/academyId`).get();
    if (!userSnap.exists() || userSnap.val() !== academyId) {
      throw new HttpsError('permission-denied', '본인 학원만 조회할 수 있습니다');
    }

    // 업무일지 위약금: 필드가 없으면(기존 고객) 0으로 처리
    const billingSnap = await db.ref(`academies/${academyId}/billing`).get();
    const billing = billingSnap.val() || {};
    let journalPenalty = 0;
    if (
      billing.regularAmount != null &&
      billing.monthlyAmount != null &&
      billing.paidCount != null
    ) {
      journalPenalty = (billing.regularAmount - billing.monthlyAmount) * billing.paidCount;
    }

    // 애드온 위약금: contract + active 항목만, cancelAddon과 동일한 공식
    const addonsSnap = await db.ref(`academies/${academyId}/addons`).get();
    const addonPenalties = [];
    if (addonsSnap.exists()) {
      for (const [addonKey, addon] of Object.entries(addonsSnap.val())) {
        if (addon.billingType === 'contract' && addon.status === 'active') {
          const paid   = addon.paidCount || 0;
          const amount = (addon.regularAmount - addon.monthlyAmount) * paid;
          const name   = ADDON_PRICE_TABLE[addonKey]?.name ?? addonKey;
          addonPenalties.push({ addonKey, name, amount });
        }
      }
    }

    const totalPenalty = journalPenalty + addonPenalties.reduce((s, a) => s + a.amount, 0);
    return { journalPenalty, addonPenalties, totalPenalty };
  },
);

// ──────────────────────────────────────────────────────────────────
// executeWithdraw  (Callable)
// 회원탈퇴 실행: 위약금 즉시 청구 → 구독 해지 → 데이터 이동
// 입력: { academyId }
//
// ⚠️ 테스트 원칙: 반드시 격리된 가짜 학원(academyId: test_*)으로만 테스트할 것.
//   - 실제 계정(billingKey 보유)으로 절대 호출 금지 — PortOne billingKey가 삭제되어 정기결제가 즉시 끊김
//   - 테스트용 학원은 Firebase Emulator 또는 테스트 전용 DB 환경에서만 생성
//   - 프로덕션 DB에서 테스트가 필요한 경우 반드시 매니저 승인 후 진행
// 반환: { success, charged, amount? } | { success, charged:false, pendingAmount }
// ──────────────────────────────────────────────────────────────────
exports.executeWithdraw = onCall(
  { region: 'asia-northeast3', timeoutSeconds: 60 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다');

    const { academyId } = request.data;
    if (!academyId) throw new HttpsError('invalid-argument', 'academyId 필수');
    assertNotProtectedForTest(academyId, 'executeWithdraw');

    // 소유권 확인 + 이메일 조회
    const userSnap = await db.ref(`users/${uid}`).get();
    if (!userSnap.exists() || userSnap.val()?.academyId !== academyId) {
      throw new HttpsError('permission-denied', '본인 학원만 탈퇴할 수 있습니다');
    }
    const userEmail = userSnap.val()?.email || '';

    const now = Date.now();

    // ── 1. 학원 설정 · billing · addons 일괄 조회
    const [settingsSnap, billingSnap, addonsSnap] = await Promise.all([
      db.ref(`academies/${academyId}/settings`).get(),
      db.ref(`academies/${academyId}/billing`).get(),
      db.ref(`academies/${academyId}/addons`).get(),
    ]);
    const settings  = settingsSnap.val() || {};
    const billing   = billingSnap.val()  || {};
    const addons    = addonsSnap.val()   || {};
    const { billingKey } = billing;

    // ── 2. 위약금 계산 (calculateWithdrawSettlement와 동일한 공식)
    let journalPenalty = 0;
    if (billing.regularAmount != null && billing.monthlyAmount != null && billing.paidCount != null) {
      journalPenalty = (billing.regularAmount - billing.monthlyAmount) * billing.paidCount;
    }
    const addonPenalties = [];
    for (const [addonKey, addon] of Object.entries(addons)) {
      if (addon.billingType === 'contract' && addon.status === 'active') {
        const paid   = addon.paidCount || 0;
        const amount = (addon.regularAmount - addon.monthlyAmount) * paid;
        addonPenalties.push({ addonKey, name: ADDON_PRICE_TABLE[addonKey]?.name ?? addonKey, amount });
      }
    }
    const totalPenalty = journalPenalty + addonPenalties.reduce((s, a) => s + a.amount, 0);

    // ── 3. 즉시 청구 (totalPenalty > 0이고 billingKey 있을 때)
    let charged     = totalPenalty === 0; // 0원이면 청구 불필요 → charged=true 처리
    let chargeError = null;

    if (totalPenalty > 0 && billingKey) {
      const paymentId = `withdraw_settlement_${academyId}_${now}`;
      const orderName = 'FILLYO 중도해지 정산금';
      try {
        const chargeResp = await axios.post(
          `${PORTONE_BASE}/payments/${paymentId}/billing-key`,
          {
            billingKey,
            orderName,
            customer: {
              customerId:  academyId,
              name:        { full: (settings.academyName || settings.name || 'Withdraw').replace(/[^\x00-\x7F]/g, '').trim() || 'Academy' },
              email:       userEmail || 'noreply@fillyo.kr',
              phoneNumber: (settings.phone || '00000000000').replace(/[^0-9]/g, ''),
            },
            amount:   { total: totalPenalty },
            currency: 'KRW',
          },
          { headers: { Authorization: `PortOne ${apiSecret()}`, 'Content-Type': 'application/json' } },
        );
        // PortOne V2 빌링키 즉시결제 성공 시 응답: { payment: { pgTxId, paidAt } }
        // status 필드가 없는 경우 paidAt 존재 여부로 성공 판별
        const payData    = chargeResp.data?.payment ?? chargeResp.data;
        const payStatus  = chargeResp.data?.status ?? payData?.status;
        const isPaid     = payStatus === 'PAID' || (payData?.paidAt && !payData?.failedAt);
        if (isPaid) {
          charged = true;
          await db.ref(`paymentOrders/${paymentId}`).set({
            type:      'withdraw_settlement',
            academyId,
            amount:    totalPenalty,
            orderName,
            billingKey,
            status:    'PAID',
            paidAt:    now,
          });
          console.log(`[executeWithdraw] 정산금 청구 성공: ${totalPenalty}원 (${academyId})`);
        } else {
          chargeError = `결제 상태: ${payStatus ?? JSON.stringify(chargeResp.data)}`;
          console.warn(`[executeWithdraw] 예상치 못한 결제 상태:`, chargeResp.data);
        }
      } catch (e) {
        chargeError = e.response?.data?.message ?? e.message;
        console.error('[executeWithdraw] 즉시 청구 실패:', e.response?.data ?? e.message);
      }
    } else if (totalPenalty > 0 && !billingKey) {
      chargeError = 'billingKey 없음 — 카드 정보 없어 청구 불가';
      console.warn(`[executeWithdraw] billingKey 없음, settlementDue 기록 (${academyId})`);
    }

    // ── 4. 청구 실패 시 settlementDue 기록 (학원 데이터 삭제 후에도 잔존)
    if (!charged && totalPenalty > 0) {
      await db.ref(`settlementDue/${academyId}`).set({
        academyName:    settings.academyName || settings.name || academyId,
        amount:         totalPenalty,
        reason:         chargeError || '청구 실패',
        failedAt:       now,
        contactPhone:   settings.phone || '',
        journalPenalty,
        addonPenalties,
      });
      console.log(`[executeWithdraw] settlementDue 기록: ${totalPenalty}원 (${academyId})`);
    }

    // ── 5. 결제 예약 전체 취소 (billingKey 기준 일괄 — 청구 완료 후)
    if (billingKey) {
      try {
        await axios.delete(
          `${PORTONE_BASE}/payment-schedules`,
          {
            headers: { Authorization: `PortOne ${apiSecret()}`, 'Content-Type': 'application/json' },
            data:    { billingKey },
          },
        );
      } catch (e) {
        console.error('[executeWithdraw] 결제 예약 취소 실패:', e.response?.data ?? e.message);
      }

      // ── 6. 빌링키 삭제 (청구 완료 후)
      try {
        await axios.delete(
          `${PORTONE_BASE}/billing-keys/${billingKey}`,
          { headers: { Authorization: `PortOne ${apiSecret()}` } },
        );
      } catch (e) {
        console.error('[executeWithdraw] 빌링키 삭제 실패:', e.response?.data ?? e.message);
      }
    }

    // ── 7. academies 데이터를 withdrawnAcademies로 복사 후 원본 삭제
    const academySnap = await db.ref(`academies/${academyId}`).get();
    if (academySnap.exists()) {
      await db.ref(`withdrawnAcademies/${academyId}`).set({
        ...academySnap.val(),
        _withdrawnAt:    now,
        _withdrawnByUid: uid,
        _totalPenalty:   totalPenalty,
        _charged:        charged,
      });
      await db.ref(`academies/${academyId}`).remove();
    }

    // ── 8. users 상태 갱신
    await db.ref(`users/${uid}`).update({ planType: 'withdrawn', withdrawnAt: now });

    console.log(`[executeWithdraw] 완료: ${academyId} charged=${charged} totalPenalty=${totalPenalty}`);

    return charged
      ? { success: true, charged: true,  amount: totalPenalty }
      : { success: true, charged: false, pendingAmount: totalPenalty };
  },
);

// ──────────────────────────────────────────────────────────────────
// parentDeskAsk
// 학부모가 질문을 보내면 학원 설정(운영시간/학원비/차량/FAQ)을 바탕으로
// Anthropic Claude가 자동 응답을 생성해 반환
// ──────────────────────────────────────────────────────────────────
exports.parentDeskAsk = onRequest(
  { region: 'asia-northeast3', timeoutSeconds: 30 },
  (req, res) => {
    cors(req, res, async () => {
      if (req.method === 'OPTIONS') return res.status(204).send('');
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      const { academyId, question } = req.body || {};
      if (!academyId || !question) {
        return res.status(400).json({ error: 'academyId, question 필수' });
      }

      try {
        const [deskSnap, keySnap] = await Promise.all([
          db.ref(`academies/${academyId}/settings/parentDesk`).get(),
          db.ref(`academies/${academyId}/settings/anthropicApiKey`).get(),
        ]);

        if (!deskSnap.exists() || !keySnap.exists()) {
          return res.status(404).json({ error: '설정 정보가 없습니다' });
        }

        const desk = deskSnap.val() || {};
        const anthropicApiKey = keySnap.val();

        if (!anthropicApiKey) {
          return res.status(404).json({ error: '설정 정보가 없습니다' });
        }

        const faqText = Array.isArray(desk.faq)
          ? desk.faq.map((item) => `Q: ${item.question}\nA: ${item.answer}`).join('\n\n')
          : (desk.faq || '');

        const systemPrompt = `당신은 태권도장에 문의하는 학부모님을 응대하는 안내 도우미입니다.

[답변 원칙]
- 아래 제공된 학원 정보(운영시간표/학원비/차량운행안내/FAQ)에 있는 내용만 답변하세요.
- 제공된 정보에 없는 질문(예: 특정 아이의 개인 성적, 상담 내용, 정보에 없는 세부 요청)은 절대 추측해서 답변하지 말고, '이 부분은 원장님께 직접 문의해주시면 정확히 안내드릴 수 있어요'라고 안내하세요.
- 따뜻하고 정중한 존댓말을 사용하세요.
- 2~3문장 이내로 간결하게 답변하세요.
- 마크다운 문법을 쓰지 마세요.

[학원 정보]
운영시간표: ${desk.schedule || '정보 없음'}
학원비 안내: ${desk.tuition || '정보 없음'}
차량 운행 안내: ${desk.carpool || '정보 없음'}
자주 묻는 질문: ${faqText || '정보 없음'}`;

        const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': anthropicApiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 500,
            system: systemPrompt,
            messages: [{ role: 'user', content: question }],
          }),
        });

        if (!anthropicRes.ok) {
          const errData = await anthropicRes.text();
          console.error('[parentDeskAsk] Anthropic API 오류:', errData);
          return res.status(502).json({ error: 'AI 응답 생성 실패' });
        }

        const data = await anthropicRes.json();
        const answer = data?.content?.[0]?.text ?? '';

        return res.status(200).json({ answer });
      } catch (e) {
        console.error('[parentDeskAsk] 처리 오류:', e.message);
        return res.status(500).json({ error: '서버 오류가 발생했습니다' });
      }
    });
  },
);

// ──────────────────────────────────────────────────────────────────
// parentDeskKakao
// 카카오 i 오픈빌더 스킬 서버 전용 엔드포인트
// - 요청: POST body = 카카오 스킬 요청 형식 { userRequest: { utterance, callbackUrl } }
//         query param: academyId
// - 응답: Kakao 5초 타임아웃 대비 → callbackUrl 있으면 useCallback: true 즉시 반환 후
//         15초 이내 callbackUrl로 실제 답변 POST
//         callbackUrl 없으면 (curl 테스트 등) 직접 응답
// ──────────────────────────────────────────────────────────────────
exports.parentDeskKakao = onRequest(
  { region: 'asia-northeast3', timeoutSeconds: 30 },
  async (req, res) => {
    if (req.method === 'OPTIONS') return res.status(204).send('');

    const academyId   = req.query.academyId;
    const question    = req.body?.userRequest?.utterance;
    const callbackUrl = req.body?.userRequest?.callbackUrl;
    const hasCallback = !!callbackUrl;

    const toKakao = (text) => ({
      version: '2.0',
      template: { outputs: [{ simpleText: { text } }] },
    });

    // 결과를 callbackUrl 또는 res로 전송하는 헬퍼
    const sendResult = async (body) => {
      if (hasCallback) {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        res.status(200).json(body);
      }
    };

    if (!academyId || !question) {
      return res.status(200).json(toKakao('요청 정보가 올바르지 않습니다. 잠시 후 다시 시도해주세요.'));
    }

    // Kakao 5초 타임아웃 대비: callbackUrl 있으면 즉시 수신확인 후 백그라운드 처리
    if (hasCallback) {
      res.status(200).json({ version: '2.0', useCallback: true });
    }

    try {
      const [deskSnap, keySnap] = await Promise.all([
        db.ref(`academies/${academyId}/settings/parentDesk`).get(),
        db.ref(`academies/${academyId}/settings/anthropicApiKey`).get(),
      ]);

      if (!deskSnap.exists() || !keySnap.exists()) {
        return await sendResult(toKakao('학원 설정 정보가 없습니다. 원장님께 문의해주세요.'));
      }

      const desk = deskSnap.val() || {};
      const anthropicApiKey = keySnap.val();

      if (!anthropicApiKey) {
        return await sendResult(toKakao('학원 설정 정보가 없습니다. 원장님께 문의해주세요.'));
      }

      const faqText = Array.isArray(desk.faq)
        ? desk.faq.map((item) => `Q: ${item.question}\nA: ${item.answer}`).join('\n\n')
        : (desk.faq || '');

      const systemPrompt = `당신은 태권도장에 문의하는 학부모님을 응대하는 안내 도우미입니다.

[답변 원칙]
- 아래 제공된 학원 정보(운영시간표/학원비/차량운행안내/FAQ)에 있는 내용만 답변하세요.
- 제공된 정보에 없는 질문(예: 특정 아이의 개인 성적, 상담 내용, 정보에 없는 세부 요청)은 절대 추측해서 답변하지 말고, '이 부분은 원장님께 직접 문의해주시면 정확히 안내드릴 수 있어요'라고 안내하세요.
- 따뜻하고 정중한 존댓말을 사용하세요.
- 2~3문장 이내로 간결하게 답변하세요.
- 마크다운 문법을 쓰지 마세요.

[학원 정보]
운영시간표: ${desk.schedule || '정보 없음'}
학원비 안내: ${desk.tuition || '정보 없음'}
차량 운행 안내: ${desk.carpool || '정보 없음'}
자주 묻는 질문: ${faqText || '정보 없음'}`;

      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          system: systemPrompt,
          messages: [{ role: 'user', content: question }],
        }),
      });

      if (!anthropicRes.ok) {
        const errData = await anthropicRes.text();
        console.error('[parentDeskKakao] Anthropic API 오류:', errData);
        return await sendResult(toKakao('AI 응답 생성에 실패했습니다. 잠시 후 다시 시도해주세요.'));
      }

      const data   = await anthropicRes.json();
      const answer = data?.content?.[0]?.text ?? '답변을 가져오지 못했습니다.';
      console.log(`[parentDeskKakao] 완료: academyId=${academyId} hasCallback=${hasCallback}`);

      await sendResult(toKakao(answer));
    } catch (e) {
      console.error('[parentDeskKakao] 처리 오류:', e.message);
      await sendResult(toKakao('서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.')).catch(() => {});
    }
  },
);

// ──────────────────────────────────────────────────────────────────
// dailyRtdbBackup
// 매일 새벽 3시(한국 시각) 전체 RTDB 스냅샷을 GCS에 저장
// 저장 경로: gs://{default-bucket}/rtdb-backups/fillyo-YYYY-MM-DD.json
// ──────────────────────────────────────────────────────────────────
exports.dailyRtdbBackup = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'Asia/Seoul', region: 'asia-northeast3' },
  async () => {
    const snapshot = await db.ref('/').get();
    const json     = JSON.stringify(snapshot.val());
    const date     = new Date().toISOString().slice(0, 10);
    const fileName = `rtdb-backups/fillyo-${date}.json`;
    const bucket   = admin.storage().bucket();
    await bucket.file(fileName).save(json, { contentType: 'application/json' });
    console.log(`[dailyRtdbBackup] 완료: ${fileName} (${(json.length / 1024).toFixed(1)} KB)`);
  },
);
