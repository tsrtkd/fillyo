'use strict';

const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const admin   = require('firebase-admin');
const axios   = require('axios');
const cors    = require('cors')({ origin: true });
const PortOne = require('@portone/server-sdk');

admin.initializeApp();
const db = admin.database();

const PORTONE_BASE = 'https://api.portone.io';

function apiSecret() {
  return process.env.PORTONE_API_SECRET;
}

// ── 애드온 가격표 ──────────────────────────────────────────────────
// billingType: 'contract'(1년 계약) | 'single'(1개월 이용권)
// regularAmount: 정가(1개월 이용권 기준) → 중도해지 차액 계산용
// single: null → 해당 billingType 불가
const ADDON_PRICE_TABLE = {
  exam:     { contract: 4900,  single: 9800,  regularAmount: 9800,  name: '승급심사' },
  jumprope: { contract: 4900,  single: 9800,  regularAmount: 9800,  name: '줄넘기' },
  bundle:   { contract: 13500, single: null,  regularAmount: 13500, name: '애드온 묶음 (줄넘기+승급심사+AI성장리포트)' },
};

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
        await db.ref(`academies/${academyId}/billing`).update({
          billingKey,
          nextPaymentAt:          timeToPay.getTime(),
          lastScheduledPaymentId: paymentId,
          lastScheduledAt:        now,
          paymentFailed:          false,
        });

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
          await db.ref(`academies/${academyId}/billing`).update({
            paymentFailed: false,
            lastPaidAt:    now,
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

    const { academyId, addonKey, billingType } = request.data;

    // 입력값 검증
    if (!academyId || !addonKey || !billingType) {
      throw new HttpsError('invalid-argument', 'academyId, addonKey, billingType 필수');
    }
    const priceInfo = ADDON_PRICE_TABLE[addonKey];
    if (!priceInfo) {
      throw new HttpsError('invalid-argument', `알 수 없는 addonKey: ${addonKey}`);
    }
    if (billingType !== 'contract' && billingType !== 'single') {
      throw new HttpsError('invalid-argument', "billingType은 'contract'(1년 계약) 또는 'single'(1개월 이용권)");
    }
    if (billingType === 'single' && priceInfo.single === null) {
      throw new HttpsError(
        'invalid-argument',
        `${priceInfo.name}은 1년 계약 전용입니다. 1개월 이용권 불가`,
      );
    }

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

    // 금액 결정
    const monthlyAmount = billingType === 'contract' ? priceInfo.contract : priceInfo.single;
    const regularAmount = priceInfo.regularAmount;
    const orderName     = `FILLYO ${priceInfo.name} ${billingType === 'contract' ? '1년 계약' : '1개월 이용권'}`;

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
// cancelAddon  (Callable)
// 특정 애드온만 해지: 해당 예약건만 취소 (업무일지 예약은 건드리지 않음)
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
    if (addon.status !== 'active') {
      throw new HttpsError('failed-precondition', '활성 상태의 애드온만 해지할 수 있습니다');
    }

    // billingKey 조회
    const billingSnap = await db.ref(`academies/${academyId}/billing`).get();
    const { billingKey } = billingSnap.val() || {};
    if (!billingKey) {
      throw new HttpsError('failed-precondition', 'billingKey가 없습니다');
    }

    const now    = Date.now();
    const paid   = addon.paidCount || 0;

    // ── 1년 약정 중도해지: 차액 계산·저장 (카드 청구 X, 관리자 수동 확인 후 청구)
    //    업무일지 중도해지와 동일한 방식
    if (addon.billingType === 'contract' && paid < 12) {
      const pendingCharge = (addon.regularAmount - addon.monthlyAmount) * paid;
      if (pendingCharge > 0) {
        await db.ref(`academies/${academyId}/addons/${addonKey}/pendingCharge`).set({
          amount:        pendingCharge,
          paidCount:     paid,
          monthlyAmount: addon.monthlyAmount,
          regularAmount: addon.regularAmount,
          calculatedAt:  now,
          reason:        `1년 약정 중도 해지: ${paid}회 결제분 할인 차액 환수 (회당 ${addon.regularAmount - addon.monthlyAmount}원 × ${paid}회)`,
        });
        console.log(`[cancelAddon] 중도해지 차액 저장: ${pendingCharge}원 (${academyId}/${addonKey})`);
      }
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
    return { ok: true, cancelledAt: now };
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
