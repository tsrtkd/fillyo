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

// ── 얼리버드 선착순 설정 ──────────────────────────────────────────
const EARLYBIRD_LIMIT = 50;
// 도장 수 카운트에서 제외할 테스트·관리자 계정 이메일
const EARLYBIRD_EXCLUDED_EMAILS = new Set([
  'test-free@fillyo.kr',
  'tsr@fillyo.kr',
  'test@fillyo.kr',
  'audtls2g@naver.com',
  'audtls2g@gmail.com',
]);

// planType === 'pro'인 실사용 도장 수 집계 (테스트·관리자 제외)
// orderByChild 인덱스 불필요 — JS 필터링 (FILLYO 규모에서 충분히 빠름)
async function countActivePaidDojangs() {
  const snap = await db.ref('users').get();
  if (!snap.exists()) return 0;
  let count = 0;
  snap.forEach(child => {
    const u = child.val();
    if (u.planType === 'pro' && u.email && !EARLYBIRD_EXCLUDED_EMAILS.has(u.email)) count++;
  });
  return count;
}

// earlybird 단계일 때 실시간으로 도장 수 확인 후 가격 결정
async function reportContractPrice() {
  if (ADDON_PRICE_TIER === 'discount30') return 13500;
  if (ADDON_PRICE_TIER === 'full') return 19800;
  // 'earlybird': 선착순 50개 도장 미만이면 9,900원, 이후 신규는 19,800원(정가)
  const count = await countActivePaidDojangs();
  return (count >= EARLYBIRD_LIMIT) ? 19800 : 9900;
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
// getEarlybirdStatus  (공개 엔드포인트 — 인증 불필요)
// 얼리버드 선착순 50개 도장 마감 여부를 클라이언트에 전달
// ──────────────────────────────────────────────────────────────────
exports.getEarlybirdStatus = onRequest(
  { region: 'asia-northeast3', timeoutSeconds: 15 },
  async (req, res) => {
    cors(req, res, async () => {
      try {
        const count = await countActivePaidDojangs();
        return res.status(200).json({ available: count < EARLYBIRD_LIMIT });
      } catch (e) {
        console.error('[getEarlybirdStatus] 오류:', e.message);
        return res.status(500).json({ error: e.message });
      }
    });
  },
);

// ──────────────────────────────────────────────────────────────────
// scheduleNextPayment
// 클라이언트가 빌키 발급 직후 호출 → 즉시 첫 회차 결제 실행
// 결제 성공 후 portoneWebhook이 paidCount 갱신 + 다음 달 자동 재예약 처리
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

      const now = Date.now();
      const paymentId = `sub_${now}_${academyId}`;

      try {
        // ── 1. 빌링 초기화 ──
        // billingKey는 재구독 시에도 항상 갱신 (취소 후 재구독 시 null 상태 방지)
        // 위약금 계산용 필드(paidCount 등)는 최초 구독 시에만 초기화
        const existingBillingSnap = await db.ref(`academies/${academyId}/billing`).get();
        const existingBilling = existingBillingSnap.val() || {};
        const billingInit = { billingKey, paymentFailed: false };
        if (existingBilling.paidCount === undefined || existingBilling.paidCount === null) {
          billingInit.monthlyAmount = amount;
          billingInit.regularAmount = 19800;
          billingInit.paidCount     = 0;
        }
        await db.ref(`academies/${academyId}/billing`).update(billingInit);

        // ── 2. 주문 정보 선저장 (웹훅이 paymentOrders를 참조해 처리하므로 결제 전에 저장) ──
        await db.ref(`paymentOrders/${paymentId}`).set({
          academyId,
          amount,
          orderName,
          billingKey,
          createdAt: now,
        });

        // ── 3. 즉시 결제 실행 ──
        const payRes = await axios.post(
          `${PORTONE_BASE}/payments/${paymentId}/billing-key`,
          {
            billingKey,
            orderName,
            customer: { id: academyId },
            amount:   { total: amount },
            currency: 'KRW',
          },
          { headers: { Authorization: `PortOne ${apiSecret()}`, 'Content-Type': 'application/json' } },
        );

        console.log('[scheduleNextPayment] 즉시결제 응답:', JSON.stringify(payRes.data));

        // PortOne V2 billing-key 즉시결제 응답 구조: { payment: { status, paidAt, ... } }
        const payData   = payRes.data?.payment ?? payRes.data;
        const payStatus = payData?.status;
        if (payStatus !== 'PAID') {
          console.error('[scheduleNextPayment] 결제 실패 — status:', payStatus, JSON.stringify(payRes.data));
          return res.status(402).json({ error: '결제 실패', status: payStatus, portoneData: payRes.data });
        }

        // 결제 성공 — paidCount 갱신·다음 달 예약은 portoneWebhook이 자동 처리
        return res.status(200).json({ ok: true, paymentId });
      } catch (e) {
        console.error('[scheduleNextPayment] 오류:', e.response?.data ?? e.message);
        return res.status(500).json({ error: '결제 실패', details: e.response?.data });
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

        } else if (status === 'CANCELLED') {
          // 애드온 취소/환불: 이력 저장 + 애드온 상태 cancelled
          await db.ref(`academies/${academyId}/payments/${paymentId}`).set({
            paymentId,
            type:        'addon',
            addonKey,
            status,
            amount:      payment.amount?.total ?? amount,
            orderName,
            cancelledAt: now,
          });
          await db.ref(`academies/${academyId}/addons/${addonKey}`).update({
            status:      'cancelled',
            cancelledAt: now,
          });

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

        } else if (status === 'CANCELLED') {
          // ③-취소/환불: 이력 저장 + 포트원 예약·빌링키 삭제 + users planType → 'free'
          await db.ref(`academies/${academyId}/payments/${paymentId}`).set({
            paymentId,
            status,
            amount:      payment.amount?.total ?? amount,
            orderName,
            cancelledAt: now,
          });

          // 포트원 결제 예약 전체 취소 (billingKey 기준)
          if (billingKey) {
            try {
              await axios.delete(
                `${PORTONE_BASE}/payment-schedules`,
                {
                  headers: { Authorization: `PortOne ${apiSecret()}`, 'Content-Type': 'application/json' },
                  data: { billingKey },
                },
              );
              console.log(`[portoneWebhook] CANCELLED: 결제 예약 취소 완료 billingKey=${billingKey}`);
            } catch (e) {
              console.error('[portoneWebhook] CANCELLED: 결제 예약 취소 실패:', e.response?.data ?? e.message);
            }

            // 포트원 빌링키 삭제
            try {
              await axios.delete(
                `${PORTONE_BASE}/billing-keys/${billingKey}`,
                { headers: { Authorization: `PortOne ${apiSecret()}` } },
              );
              console.log(`[portoneWebhook] CANCELLED: 빌링키 삭제 완료`);
            } catch (e) {
              console.error('[portoneWebhook] CANCELLED: 빌링키 삭제 실패:', e.response?.data ?? e.message);
            }
          }

          // academyId로 uid 조회 후 planType free 처리
          const usersSnap = await db.ref('users')
            .orderByChild('academyId').equalTo(academyId).limitToFirst(1).get();
          if (usersSnap.exists()) {
            const uid = Object.keys(usersSnap.val())[0];
            await db.ref(`users/${uid}`).update({ planType: 'free', cancelledAt: now });
            console.log(`[portoneWebhook] CANCELLED: uid=${uid} planType → free`);
          } else {
            console.warn('[portoneWebhook] CANCELLED: academyId로 uid 조회 실패:', academyId);
          }

          await db.ref(`academies/${academyId}/billing`).update({
            paymentFailed: false,
            cancelledAt:   now,
            status:        'cancelled',
            billingKey:    null,
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
        if (e.response?.status === 409) {
          // 이미 취소됐거나 존재하지 않는 스케줄 → 이미 취소된 상태이므로 계속 진행
          console.warn('[cancelSubscription] ① 결제 예약 이미 취소된 상태 (409) — 계속 진행');
        } else {
          const portoneMsg = e.response?.data?.message ?? e.message;
          console.error('[cancelSubscription] ① 결제 예약 취소 실패:', portoneMsg);
          return res.status(500).json({ error: '결제 예약 취소 실패: ' + portoneMsg });
        }
      }

      // ② 빌링키 삭제
      try {
        await axios.delete(
          `${PORTONE_BASE}/billing-keys/${billingKey}`,
          { headers: { Authorization: `PortOne ${apiSecret()}` } },
        );
      } catch (e) {
        if (e.response?.status === 409) {
          // 이미 삭제된 빌링키 → 이미 처리된 상태이므로 계속 진행
          console.warn('[cancelSubscription] ② 빌링키 이미 삭제된 상태 (409) — 계속 진행');
        } else {
          console.error('[cancelSubscription] ② 빌링키 삭제 실패:', e.response?.data ?? e.message);
          return res.status(500).json({ error: '빌링키 삭제 실패', details: e.response?.data });
        }
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
    const monthlyAmount = await reportContractPrice();
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
        if (e.response?.status === 409) {
          // 이미 취소됐거나 존재하지 않는 스케줄 → 이미 취소된 상태이므로 계속 진행
          console.warn(`[cancelAddon] PortOne 예약 이미 취소된 상태 (409) — 계속 진행: scheduleId=${addon.currentScheduleId}`);
        } else {
          const detail = e.response?.data ?? e.message;
          console.error('[cancelAddon] PortOne 예약 취소 실패:', detail);
          throw new HttpsError('internal', '예약 취소 실패: ' + JSON.stringify(detail));
        }
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
// generateGrowthReport  (Callable)
// AI성장리포트 생성 — FILLYO 자체 Anthropic API 키로 서버에서 처리
// 입력: { academyId, studentId, studentName, userContent, dojanKeyword? }
// ──────────────────────────────────────────────────────────────────
exports.generateGrowthReport = onCall(
  { region: 'asia-northeast3', timeoutSeconds: 60 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다');

    const { academyId, studentId, studentName, userContent, dojanKeyword = '' } = request.data;
    if (!academyId || !userContent) {
      throw new HttpsError('invalid-argument', 'academyId, userContent 필수');
    }

    // 소유권 확인
    const userSnap = await db.ref(`users/${uid}/academyId`).get();
    if (!userSnap.exists() || userSnap.val() !== academyId) {
      throw new HttpsError('permission-denied', '본인 학원만 리포트를 생성할 수 있습니다');
    }

    // 접근 권한 확인 (admin 제외)
    const isAdmin = request.auth?.token?.email === 'audtls2g@gmail.com';
    if (!isAdmin) {
      const addonSnap = await db.ref(`academies/${academyId}/addons/report/status`).get();
      if (!addonSnap.exists() || addonSnap.val() !== 'active') {
        throw new HttpsError('permission-denied', 'AI성장리포트 애드온이 활성 상태가 아닙니다');
      }
    }

    // 일일 사용량 체크 (학원당 50회 한도) — orderByChild 인덱스 불필요
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const allUsageSnap = await db.ref(`academies/${academyId}/aiUsage`).get();
    let todayCount = 0;
    if (allUsageSnap.exists()) {
      allUsageSnap.forEach(child => {
        if ((child.val().timestamp || 0) >= todayStart.getTime()) todayCount++;
      });
    }
    if (todayCount >= 50) {
      throw new HttpsError('resource-exhausted', '오늘 AI 리포트 생성 한도(50회)에 도달했습니다. 내일 다시 시도해주세요.');
    }

    // 시스템 프롬프트 (report/index.html의 generateReport()에서 그대로 이식)
    const systemPromptText = `당신은 태권도장 원장님을 도와 학부모에게 보낼 학생 성장 리포트 문구를 작성하는 전문 도우미입니다.

[작성 원칙]
- 주어진 데이터에 있는 항목만 자연스럽게 포함하고, 없는 항목은 절대 언급하지 마세요.
- 마크다운 문법(**굵게** 등)은 절대 사용하지 마세요. 일반 텍스트로만 작성하세요.
- 따뜻하고 전문적인 톤으로, 학부모가 카카오톡으로 받았을 때 기분 좋게 읽힐 수 있도록 작성하세요.
- 400~600자 내외로 작성하세요. 데이터 양에 따라 유연하게 조절하세요.
- 학원명 태그 없이 바로 인사말로 시작하세요. 아이 이름을 자연스럽게 포함하세요.
- 문단을 3~4개로 나눠 작성하세요: ①출석/성실도 ②실력(심사/줄넘기) ③성장(신체/성격) ④지도진 다짐

[줄넘기 급수 설명 - 급수 언급 시 반드시 포함]
10급: 모둠발 앞으로 뛰기 (줄넘기의 첫 걸음)
9급: 모둠발 뒤로 뛰기
8급: 한발 번갈아 뛰기
7급: 가위바위보 뛰기
6급: 무릎올리기+엉덩이차기
5급: 엇걸어 뛰기 (줄이 몸 앞에서 교차)
4급: 엇걸었다 풀어 뛰기
3급: 되돌리기
2급: 되돌리기+다리 들어주기
1급: 2단 뛰기 (줄넘기 최고 기술 중 하나)
- 현재 급수가 무엇을 완성했는지, 다음 급수에서 무엇에 도전하는지 설명하세요.

[태권도 띠별 심사 내용 - 띠 언급 시 반드시 포함]
흰띠/흰검띠: 기본 자세와 예절 (태권도의 첫 시작)
노란띠/노검띠: 태극 1장 + 앞차기
주황띠/주황검띠: 태극 2장 + 돌려차기
초록띠/초록검띠: 태극 3장 + 내려차기
파란띠/파란검띠: 태극 4장 + 옆차기
보라띠/보라검띠: 태극 5장 + 옆차기(발날)
밤띠/밤검띠: 태극 6장 + 옆후려차기
빨간띠: 태극 1장~8장 종합 + 약속겨루기 (국기원 승품단심사 준비 단계)
1품단: 고려 품새 + 뒤차기, 익스트림: 돌려+돌게+뒤후려차기/에어리얼 (검은띠의 시작, 태권도 수련의 새로운 단계)
2품단: 금강 품새 + 뛰어뒤차기, 익스트림: 팜턴/핸드스프링
3품단: 태백 품새 + 뛰어옆차기, 익스트림: 외발턴540도/하우스턴
4품단: 평원 품새 + 가위차기, 익스트림: 720도이상/뒤공중앞공중

[유급자(흰띠~빨간띠) 작성 방식]
- 현재 띠에서 배우는 기술이 무엇인지 설명하고, 다음 심사에서 도전할 내용을 언급하세요.

[품단(1~4품단) 작성 방식]
- 품단은 같은 품새를 더 깊이 익히며 완성도를 높여가는 단계임을 설명하세요.
- "지난번보다 동작이 더 정확해졌다", "힘과 균형이 발전했다" 등 성숙과 숙달의 언어를 사용하세요.
- 다음 단계 기술 설명 대신, 현재 수련의 깊이와 성장을 강조하세요.

[신체 기록 작성 방식]
- 키와 몸무게를 구체적인 숫자로 언급하세요. (예: "키 142.5cm, 몸무게 38kg")
- 이전 기록이 있으면 변화를 자연스럽게 언급하세요. (예: "지난달보다 키가 0.5cm 자랐어요")

[신체발달 해석 작성 방식]
- 키/몸무게 수치를 언급한 뒤, 질병관리청 소아청소년 성장도표를 참고하여 또래 평균 범위 안에서 건강하게 잘 자라고 있다는 안심 톤의 해석을 한 문장 자연스럽게 덧붙이세요.
- 백분위수(%), 순위, 저체중·과체중 같은 판단성 표현은 절대 사용하지 마세요. "또래 성장 곡선 안에서 건강하게 자라고 있어요"처럼 안심을 주는 표현만 사용하세요.
- 신체 기록이 없으면 이 문단 전체를 생략하세요.

[출석/성실 코칭 작성 방식]
- 결석이 1일 이상이면: 규칙적으로 도장에 나오는 것 자체가 "성실"이라는 가치를 배우는 과정임을 설명하고, 결석이 이어지면 생활 리듬이 흐트러져 오히려 다니기 더 힘들어질 수 있다는 점을 부드럽게 짚어주세요. 꾸준한 출석이 실력과 자신감의 기초가 된다고 언급한 뒤, 가정에서 규칙적인 등원을 함께 도와달라고 협력적으로 부탁하세요.
- 아이나 부모를 탓하는 어조는 절대 금지. "함께 만들어가자"는 톤을 유지하세요.
- 결석이 0일이면 성실함을 짧게 칭찬하는 문장만 쓰고 위 코칭은 생략하세요.

[학습 어려움 안내 작성 방식]
- 최근 심사 결과가 불합격이거나, 기간 내 특이사항에 품새 암기·발차기·동작 습득 관련 어려움을 암시하는 내용이 있으면 이 섹션을 포함하세요.
- 이런 어려움은 태권도를 배우는 과정에서 누구나 겪는 정상적인 성장 과정임을 전문가적 어조로 설명하세요. 아이가 "힘들다"고 말하는 것이 그만둬야 할 신호가 아니라 새로운 기술을 익히는 중이라는 증거임을 부모가 이해하도록 안내하세요.
- 도장에서 구체적으로 어떻게 지도할지(반복 연습, 개별 지도 등) 한 줄 포함하고, 가정에서는 "힘들다"는 말을 들었을 때 다그치지 말고 격려해달라는 부탁으로 마무리하세요.
- 해당 사항이 없으면 이 섹션 전체를 생략하세요.

[성격/태도 가치 코칭 작성 방식]
- 성격/태도 특성이 있을 때만 이 섹션을 포함하세요.
- 체크된 성격/태도 특성이 여러 개이더라도, 모든 특성을 다 언급하지 마세요. 그 중 가장 눈에 띄거나 의미 있는 1~2개만 선택해서 깊이 있게 다루세요. 선택한 특성마다 반드시 아래 4단계 구조를 자연스러운 문장으로 모두 포함하세요:
  ① 관찰: 아이에게서 실제로 보이는 모습을 구체적으로 서술
  ② 가치 설명: 그 특성이 왜 중요한 가치인지 짧게 설명
  ③ 도장의 노력: 도장에서 이 부분을 어떻게 지도할지 한 줄
  ④ 가정 요청: 부모님이 가정에서 도와줄 수 있는 구체적인 방법 한 줄
- 나머지 특성들(선택되지 않은 것들)은 언급하지 않거나, 문장 맨 앞에 짧은 관찰 한 줄 정도로만 스치듯 지나가세요. 여러 특성을 나열식으로 쭉 늘어놓는 것은 절대 금지입니다.
- MBTI, 에니어그램, 혈액형 등 성인용 유형 진단·라벨은 절대 사용하지 마세요.
- "몇째마당" 같은 목차 번호 표현은 절대 사용하지 말고, 가치 이름(성실, 예의, 인내 등)만 자연스럽게 사용하세요.
- 활발함/차분함, 외향적/내성적, 긍정적/부정적, 리더형/팔로워형 같은 성격·기질 특성은 옳고 그름 없는 타고난 개성이므로 있는 그대로 관찰 서술만 하고 가치 코칭이나 개선 제안을 붙이지 마세요.
- 아래 특성에는 전문가적 소견으로 가치 코칭 문장을 덧붙이세요:
  · 성실함/들쑥날쑥 → 성실 가치
  · 끝까지 해냄/쉽게 포기 → 인내 가치
  · 실패 후 재도전/좌절 오래감 → 용기·자신감 가치
  · 배려심 높음/갈등 잦음 → 배려·예의 가치
  · 협동 잘함/혼자 노는 편 → 협동 가치
  · 규칙 잘 지킴/규칙 어기는 편 → 준법정신 가치
  · 집중력 높음/산만함 → 신중함 가치 (ADHD·주의력 부족 등 의학적 표현 절대 금지, 태도의 문제로만 다룰 것)
  · 신중함/충동적 → 신중 가치
  · 스스로 열심히/시키는 것만 → 주도성·책임감 가치
- 성장이 필요한(neg) 특성은 아이를 탓하는 말투 대신 "~을 배워가는 시기입니다"처럼 성장 중심 어조로 서술하고, 그 가치가 왜 중요한지 짧게 설명한 뒤 도장의 지도 노력과 가정에서 도와줄 수 있는 구체적 방법을 한 줄 제안하세요.
- 이미 잘하는(pos) 특성은 그 가치를 실천하고 있음을 전문가적으로 인정하고 칭찬하세요.
- 성격/태도 특성이 없으면 이 섹션 전체를 생략하세요.
${dojanKeyword ? `
[이번 달 도장 키워드 반영 방식]
- 이번 달 도장 전체가 강조하는 가치: "${dojanKeyword}"
- 키워드가 있으면, 전체 리포트 중 "성격/태도 가치 코칭" 문단 앞에 이 키워드만을 위한 짧은 독립 문단을 하나 추가하세요. 이 문단은:
  1) "이번 달 저희 도장은 '${dojanKeyword}'을(를) 핵심 가치로 강조하고 있습니다" 같은 문장으로 시작해서
  2) 이 학생의 실제 데이터(출석, 성격/태도 특성, 심사 결과 등) 중 이 키워드와 자연스럽게 연결되는 구체적인 모습을 1~2문장으로 보여주세요
- 이 독립 문단은 다른 문단들과 분리된 별도 문단으로 작성하세요 (기존 문단 안에 한 문장으로 섞어 넣지 마세요)
- 학생 데이터와 전혀 관련 없는 키워드라면, 이 독립 문단 자체를 생략하고 억지로 만들지 마세요
- 이후 이어지는 "성격/태도 가치 코칭" 문단에서 이미 이 키워드 문단에서 다룬 내용을 중복해서 다시 쓰지 마세요` : ''}

[업무일지 메모 작성 방식]
- 민감한 내용(싸움, 갈등 등)은 직접 언급하지 말고 "친구들과의 관계에서 배려와 대화를 배우고 있습니다" 처럼 긍정적으로 순화하세요.

[마지막 문단 - 항상 포함]
- "저희 지도진은 앞으로 ~에 더욱 신경 쓰겠습니다" 형식으로 지도진의 다짐을 자연스럽게 포함하세요.`;

    // Anthropic API 호출 (서버에서 직접, FILLYO 자체 API 키 사용)
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':          process.env.ANTHROPIC_API_KEY,
        'anthropic-version':  '2023-06-01',
        'content-type':       'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 2048,
        system: [{ type: 'text', cache_control: { type: 'ephemeral' }, text: systemPromptText }],
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!anthropicRes.ok) {
      const errData = await anthropicRes.text();
      console.error('[generateGrowthReport] Anthropic API 오류:', errData);
      throw new HttpsError('internal', 'AI 리포트 생성 실패');
    }

    const data  = await anthropicRes.json();
    const text  = data?.content?.[0]?.text || '';
    const usage = data?.usage || {};

    console.log(`[generateGrowthReport] 완료: ${academyId}/${studentId} usage=${JSON.stringify(usage)}`);
    return { text, usage };
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
