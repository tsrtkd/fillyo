'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const admin  = require('firebase-admin');
const axios  = require('axios');
const cors   = require('cors')({ origin: true });
const PortOne = require('@portone/server-sdk');

admin.initializeApp();
const db = admin.database();

const PORTONE_BASE = 'https://api.portone.io';

function apiSecret() {
  return process.env.PORTONE_API_SECRET;
}

// 다음 달 동일 일자 계산 (월말 보정 포함)
function nextMonthSameDay(from = new Date()) {
  const d = new Date(from);
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

      const paymentId  = `sub_${Date.now()}_${academyId}`;
      const timeToPay  = nextMonthSameDay();

      try {
        await axios.post(
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

        const now = Date.now();

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
          scheduledAt: now,
        });

        return res.status(200).json({ ok: true, paymentId, timeToPay: timeToPay.toISOString() });
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

    // PortOne V2 웹훅 바디에서 paymentId 추출 (위변조 방지를 위해 실제 조회 필수)
    const body      = req.body || {};
    const paymentId = body?.data?.paymentId ?? body?.paymentId ?? body?.payment_id;

    if (!paymentId) {
      console.warn('[portoneWebhook] paymentId 없음:', JSON.stringify(body));
      return res.status(200).send('ok');
    }

    try {
      // ① PortOne 단건 조회로 실제 결제 상태 확인
      const { data: payment } = await axios.get(
        `${PORTONE_BASE}/payments/${paymentId}`,
        { headers: { Authorization: `PortOne ${apiSecret()}` } },
      );
      const status = payment.status; // 'PAID' | 'FAILED' | 'CANCELLED' | ...

      // ② Firebase에서 주문 정보(academyId) 조회
      const orderSnap = await db.ref(`paymentOrders/${paymentId}`).get();
      if (!orderSnap.exists()) {
        console.warn('[portoneWebhook] 주문 정보 없음:', paymentId);
        return res.status(200).send('ok');
      }
      const { academyId, amount, orderName, billingKey } = orderSnap.val();
      const now = Date.now();

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
        const nextId      = `sub_${Date.now()}_${academyId}`;
        const nextTime    = nextMonthSameDay();
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
    } catch (e) {
      // 웹훅은 항상 200 반환 (PortOne 재시도 방지)
      console.error('[portoneWebhook] 처리 오류:', e.response?.data ?? e.message);
    }

    return res.status(200).send('ok');
  },
);
