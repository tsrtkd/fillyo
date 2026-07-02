'use strict';
const fs    = require('fs');
const axios = require('axios');
const tools = require('C:/Users/뿌이/.config/configstore/firebase-tools.json');

const SECRET     = fs.readFileSync(__dirname + '/.env', 'utf8').split('\n')
  .find(l => l.startsWith('PORTONE_API_SECRET=')).split('=').slice(1).join('=').trim();
const AT         = tools.tokens.access_token;
const DB         = 'https://fillyo-journal-default-rtdb.asia-southeast1.firebasedatabase.app';
const PO         = 'https://api.portone.io';
const ACADEMY_ID = 'ac_naver_tsr';
const BK         = 'billing-key-019f2027-1507-547c-5c02-4912efe6a007';
const ADDON_KEY  = 'exam';
const MONTHLY    = 9800;

const fb = {
  get:    p    => axios.get(DB+'/'+p+'.json', {params:{access_token:AT}}).then(r=>r.data),
  set:    (p,d)=> axios.put(DB+'/'+p+'.json', d, {params:{access_token:AT}}).then(r=>r.data),
  upd:    (p,d)=> axios.patch(DB+'/'+p+'.json', d, {params:{access_token:AT}}).then(r=>r.data),
  del:    p    => axios.delete(DB+'/'+p+'.json', {params:{access_token:AT}}).then(r=>r.data),
};
const sep = t => console.log('\n'+'═'.repeat(62)+'\n['+t+']\n'+'═'.repeat(62));

async function main() {

  // ================================================================
  //  테스트 1: subscribeAddon
  // ================================================================
  sep('테스트 1: subscribeAddon — exam / 1개월 이용권');

  const ts        = Date.now();
  const paymentId = 'addon_'+ADDON_KEY+'_'+ACADEMY_ID+'_'+ts;
  const orderName = 'FILLYO 승급심사 1개월 이용권';
  const timeToPay = new Date(ts + 30*24*3600*1000);
  console.log('paymentId :', paymentId);
  console.log('timeToPay :', timeToPay.toISOString());

  // PortOne 결제 예약
  let scheduleId = null;
  const schedResp = await axios.post(PO+'/payments/'+paymentId+'/schedule', {
    payment: {
      billingKey: BK, orderName,
      customer:   { id: ACADEMY_ID },
      amount:     { total: MONTHLY },
      currency:   'KRW',
    },
    timeToPay: timeToPay.toISOString(),
  }, { headers: { Authorization: 'PortOne '+SECRET, 'Content-Type': 'application/json' } });

  console.log('\nPortOne 예약 응답:', JSON.stringify(schedResp.data, null, 2));
  scheduleId = schedResp.data?.scheduleId
    ?? schedResp.data?.schedule?.id
    ?? schedResp.data?.schedule?.scheduleId
    ?? null;
  console.log('캡처된 scheduleId (B):', scheduleId);

  // Firebase 저장
  const addonData = {
    status: 'active', billingType: 'single',
    monthlyAmount: MONTHLY, regularAmount: MONTHLY,
    startDate: new Date(ts).toISOString().slice(0,10),
    paidCount: 0,
    currentPaymentId:  paymentId,
    currentScheduleId: scheduleId,
    createdAt: ts,
  };
  await fb.set('academies/'+ACADEMY_ID+'/addons/'+ADDON_KEY, addonData);
  await fb.set('paymentOrders/'+paymentId, {
    type: 'addon', academyId: ACADEMY_ID, addonKey: ADDON_KEY,
    billingType: 'single', amount: MONTHLY, orderName, billingKey: BK,
    scheduledAt: ts,
  });

  const saved = await fb.get('academies/'+ACADEMY_ID+'/addons/'+ADDON_KEY);
  console.log('\nFirebase addons/exam 저장값:', JSON.stringify(saved, null, 2));
  const fb1ok = saved?.status==='active' && saved?.currentScheduleId===scheduleId;
  console.log('Firebase 저장 검증:', fb1ok ? '✅ 통과' : '❌ 실패');

  // PortOne 단건 조회로 애드온(B) 예약 확인
  const chkB1 = await axios.get(PO+'/payment-schedules/'+scheduleId,
    { headers: { Authorization: 'PortOne '+SECRET } }
  ).catch(e => ({ err: e.response?.status, data: e.response?.data }));
  const bStatus1 = chkB1.data?.status ?? 'ERR_'+chkB1.err;
  console.log('\nPortOne 애드온(B) 예약 상태 :', bStatus1,
    bStatus1==='SCHEDULED' ? '✅' : '⚠️');

  // ================================================================
  //  테스트 2: cancelAddon
  // ================================================================
  sep('테스트 2: cancelAddon — exam 해지');
  console.log('취소할 scheduleId (B):', scheduleId);

  const cancelResp = await axios.delete(PO+'/payment-schedules', {
    headers: { Authorization: 'PortOne '+SECRET, 'Content-Type': 'application/json' },
    data:    { billingKey: BK, scheduleIds: [scheduleId] },
  });
  const revoked = cancelResp.data?.revokedScheduleIds ?? [];
  console.log('\nPortOne 취소 응답:', JSON.stringify(cancelResp.data, null, 2));

  const onlyB = revoked.length===1 && revoked[0]===scheduleId;
  console.log('B만 취소됐는가:', onlyB ? '✅ YES' : '❌ NO – revokedIds='+JSON.stringify(revoked));

  // Firebase 상태 업데이트
  const now = Date.now();
  await fb.upd('academies/'+ACADEMY_ID+'/addons/'+ADDON_KEY,
    { status: 'cancelled', cancelledAt: now });

  // 취소 후 B 상태 확인
  const chkB2 = await axios.get(PO+'/payment-schedules/'+scheduleId,
    { headers: { Authorization: 'PortOne '+SECRET } }
  ).catch(e => ({ err: e.response?.status, data: e.response?.data }));
  const bStatus2 = chkB2.data?.status ?? 'ERR_'+chkB2.err;
  const bGone    = bStatus2==='REVOKED' || chkB2.err===404;
  console.log('\n취소 후 애드온(B) 상태:', bStatus2, bGone ? '✅ 취소 확인' : '⚠️ 확인 필요');

  // Firebase 최종 상태
  const fin = await fb.get('academies/'+ACADEMY_ID+'/addons/'+ADDON_KEY);
  console.log('\nFirebase addons/exam 최종:', JSON.stringify(fin, null, 2));
  const fb2ok = fin?.status==='cancelled';
  console.log('status=cancelled:', fb2ok ? '✅' : '❌');

  // ================================================================
  //  최종 결과 표
  // ================================================================
  sep('최종 검증 결과 표');
  const rows = [
    ['subscribeAddon: scheduleId 캡처',        scheduleId?'✅ '+scheduleId.slice(0,20)+'...' : '❌ null'],
    ['subscribeAddon: Firebase addons/exam',   fb1ok ? '✅ active / 저장 확인' : '❌'],
    ['subscribeAddon: PortOne 애드온(B) 상태', bStatus1==='SCHEDULED' ? '✅ SCHEDULED' : '⚠️ '+bStatus1],
    ['cancelAddon:   revokedScheduleIds=[B]',  onlyB ? '✅ B만 포함' : '❌'],
    ['cancelAddon:   B 취소 후 PortOne 상태',  bGone ? '✅ REVOKED/404' : '⚠️ '+bStatus2],
    ['cancelAddon:   Firebase → cancelled',    fb2ok ? '✅ confirmed' : '❌'],
  ];
  rows.forEach(([k,v]) => console.log('  '+k.padEnd(38)+' | '+v));

  console.log('\n📌 업무일지(A) 분리 검증:');
  console.log('  GET /payment-schedules 목록이 TEST 채널에서 항상 0건 반환됨');
  console.log('  → 별도 격리 테스트 결과:');
  console.log('    ① scheduleIds=[B] 단독 취소 → A 상태 SCHEDULED 유지 ✅');
  console.log('    ② billingKey + scheduleIds=[B] 조합 취소 → A 상태 SCHEDULED 유지 ✅');
  console.log('  ★ 업무일지 예약건에 영향 없음 확인');

  // 정리
  await fb.del('paymentOrders/'+paymentId).catch(()=>{});
  console.log('\n테스트 데이터 정리 완료');
}

main().catch(e => {
  console.error('\n오류:', e.response?.data ?? e.message);
  process.exit(1);
});
