'use strict';
/**
 * setup-test-accounts.js — 4개 테스트 계정에 academies + users 데이터 생성
 * 사용법: node setup-test-accounts.js
 *
 * ⚠️  절대 건드리지 않는 학원: ac_mq2avp88kwmd, ac_mqeizbqcgyxo
 */

const axios   = require('./functions/node_modules/axios');
const tools   = require('C:/Users/뿌이/.config/configstore/firebase-tools.json');
const AT      = tools.tokens.access_token;
const DB_BASE = 'https://fillyo-journal-default-rtdb.asia-southeast1.firebasedatabase.app';

// ── 안전장치 ──────────────────────────────────────────────────────────
const PROTECTED_ACADEMY_IDS = ['ac_mq2avp88kwmd', 'ac_mqeizbqcgyxo'];

function assertSafe(academyId) {
  if (PROTECTED_ACADEMY_IDS.includes(academyId)) {
    throw new Error(`[안전장치] ${academyId}는 실제 고객 학원 — 작업 강제 차단`);
  }
  if (!academyId.startsWith('test_')) {
    throw new Error(`[안전장치] academyId '${academyId}'가 test_ 접두사 없음 — 거부`);
  }
}

const fb = {
  get: (path) =>
    axios.get(`${DB_BASE}/${path}.json`, { params: { access_token: AT } })
      .then(r => r.data).catch(() => null),

  set: (path, data) =>
    axios.put(`${DB_BASE}/${path}.json`, data, {
      params:  { access_token: AT },
      headers: { 'Content-Type': 'application/json' },
    }).then(r => r.data),

  update: (path, data) =>
    axios.patch(`${DB_BASE}/${path}.json`, data, {
      params:  { access_token: AT },
      headers: { 'Content-Type': 'application/json' },
    }).then(r => r.data),
};

// ── 계정 정의 ─────────────────────────────────────────────────────────
const ACCOUNTS = [
  {
    email:      'test@fillyo.kr',
    uid:        'YITioXfKbfRffkQwZsxyGalLbDW2',
    academyId:  'test_fillyo1',
    academyName: '테스트학원1',
    ownerName:  '테스트원장',
    planType:   'free',
  },
  {
    email:      'tsr@fillyo.kr',
    uid:        'lo8mFQtERBPZV6OSpRsmdCfgLm93',
    academyId:  'test_tsr',
    academyName: '테스트도장',
    ownerName:  '테스트관장',
    planType:   'free',
  },
  {
    email:      'audtls2g@naver.com',
    uid:        'UZS1O61nFSRjU729xD9tyRcXgsi2',
    academyId:  'test_taesarang',
    academyName: '태사랑권도테스트',
    ownerName:  '태사랑원장',
    planType:   'free',
  },
  {
    email:      'test-free@fillyo.kr',
    uid:        'uTePeANzntdPH6DOc9czROxsDon1',
    academyId:  'test_free_pro',
    academyName: '테스트결제학원',
    ownerName:  '결제테스트원장',
    planType:   'pro',
    // billingKey는 없음 — 실제 결제 절차 필요
  },
];

async function createAccount(acct) {
  const { email, uid, academyId, academyName, ownerName, planType } = acct;
  assertSafe(academyId);

  console.log(`\n[${email}] 처리 시작...`);

  // 이미 존재하는지 확인
  const existingUser    = await fb.get(`users/${uid}`);
  const existingAcademy = await fb.get(`academies/${academyId}`);

  if (existingUser?.academyId && existingUser.academyId !== academyId) {
    console.log(`  ⚠️  users/${uid}에 다른 academyId(${existingUser.academyId}) 이미 존재 → 덮어쓰기 안 함`);
    return { skipped: true, reason: '기존 academyId 존재' };
  }

  // 1. academies/{academyId} 생성 (없을 때만)
  if (!existingAcademy) {
    const academyData = {
      settings: {
        academyName,
        ownerName,
        type:      'taekwondo',
        planType,
        buCount:   1,
        buLabels:  { '1': '1부' },
        parentDesk: { intro: '', faqs: [] },
        createdAt: Date.now(),
        phone:     '',
        address:   '',
      },
      members: { [uid]: 'owner' },
    };
    await fb.set(`academies/${academyId}`, academyData);
    console.log(`  ✅ academies/${academyId} 생성 완료`);
  } else {
    console.log(`  ⏭️  academies/${academyId} 이미 존재 → 건너뜀`);
  }

  // 2. users/{uid} 생성/업데이트
  const userData = {
    email,
    planType,
    academyId,
    createdAt:  existingUser?.createdAt || Date.now(),
    ownerName,
  };
  // pro 계정: planExpiry 1년 후 (billingKey 없으므로 자동갱신 없음 — 테스트 기간 충분)
  if (planType === 'pro') {
    userData.planExpiry = Date.now() + 365 * 24 * 60 * 60 * 1000;
  }
  await fb.set(`users/${uid}`, userData);
  console.log(`  ✅ users/${uid} 생성/업데이트 완료`);

  return { success: true };
}

async function main() {
  console.log('='.repeat(70));
  console.log('  테스트 계정 academies + users 데이터 생성');
  console.log(`  실행 시각: ${new Date().toISOString()}`);
  console.log('='.repeat(70));

  // 보호된 학원 건드리지 않음을 먼저 확인
  console.log('\n[안전장치 확인]');
  for (const id of PROTECTED_ACADEMY_IDS) {
    const data = await fb.get(`academies/${id}/settings`);
    const name = data?.academyName || data?.name || '(이름 없음)';
    console.log(`  🔒 ${id} (${name}) — 이 스크립트에서 절대 수정하지 않음`);
  }

  console.log('\n[계정 데이터 생성]');
  const results = [];
  for (const acct of ACCOUNTS) {
    try {
      const r = await createAccount(acct);
      results.push({ email: acct.email, ...r });
    } catch (e) {
      console.log(`  ❌ 오류: ${e.message}`);
      results.push({ email: acct.email, error: e.message });
    }
  }

  // ── 결과 확인 ──
  console.log('\n='.repeat(70));
  console.log('  생성 후 최종 상태 확인');
  console.log('='.repeat(70));
  for (const acct of ACCOUNTS) {
    const user    = await fb.get(`users/${acct.uid}`);
    const academy = await fb.get(`academies/${acct.academyId}/settings`);
    const ok = user?.academyId === acct.academyId && !!academy;
    console.log(`${ok ? '✅' : '❌'} ${acct.email.padEnd(28)} academyId=${user?.academyId || 'NONE'}  planType=${user?.planType || '?'}  학원명=${academy?.academyName || 'NONE'}`);
  }

  console.log('\n[test-free@fillyo.kr billingKey 안내]');
  console.log('  이 계정은 planType=pro로 설정되었지만 billingKey가 없습니다.');
  console.log('  애드온 결제 테스트를 위한 실제 billingKey 발급 방법:');
  console.log('  1. https://fillyo.kr/pricing/ 에서 test-free@fillyo.kr로 로그인');
  console.log('  2. Pro 구독 신청 클릭');
  console.log('  3. PortOne 테스트 카드 번호 입력:');
  console.log('     • 카드번호: 4242 4242 4242 4242');
  console.log('     • 유효기간: 12/25 (미래 아무 날짜)');
  console.log('     • CVC:      100');
  console.log('     • 비밀번호 앞 2자리: 00');
  console.log('  4. 결제 완료 후 billingKey가 자동 저장됨');
}

main().catch(e => {
  console.error('실행 오류:', e.message);
  process.exit(1);
});
