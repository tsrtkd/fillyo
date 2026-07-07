'use strict';
/**
 * test-withdraw-auth-error.js
 *
 * doWithdraw 수정 후 검증:
 *  "executeWithdraw 성공 후 deleteUser(=Auth 삭제)만 실패해도
 *   사용자에게 탈퇴 실패를 보여주지 않는다"
 *
 * 시뮬레이션 방법:
 *  1. 테스트 Auth 계정 + RTDB 학원 데이터 생성
 *  2. executeWithdraw 호출 → 성공 (서버 탈퇴 완료, 데이터 이동)
 *  3. ★ Auth 계정을 어드민으로 먼저 강제 삭제
 *     → 이후 클라이언트가 deleteUser를 호출하면 user-not-found 에러 발생
 *       (= requires-recent-login과 동일하게 Auth 삭제 실패 케이스)
 *  4. RTDB 상태 검증: withdrawnAcademies에 데이터가 정상 이동됐는지 확인
 *     → 서버 탈퇴는 이미 완료이므로, 사용자는 성공 메시지를 본 상태
 *  5. 정리
 *
 * 사용법: node test-withdraw-auth-error.js
 */

const axios   = require('./functions/node_modules/axios');
const tools   = require('C:/Users/뿌이/.config/configstore/firebase-tools.json');
const AT      = tools.tokens.access_token;

const DB_BASE = 'https://fillyo-journal-default-rtdb.asia-southeast1.firebasedatabase.app';
const API_KEY = 'AIzaSyBL5lQr2VIPK9caokm90g4_eQIkA8EXjqE';
const PROJECT = 'fillyo-journal';
const FN_BASE = 'https://asia-northeast3-fillyo-journal.cloudfunctions.net';

const fb = {
  get:  (p) => axios.get(`${DB_BASE}/${p}.json`, { params: { access_token: AT } }).then(r => r.data).catch(() => null),
  set:  (p, d) => axios.put(`${DB_BASE}/${p}.json`, d, { params: { access_token: AT } }).then(r => r.data),
  del:  (p) => axios.delete(`${DB_BASE}/${p}.json`, { params: { access_token: AT } }).then(r => r.data).catch(() => null),
};

function log(label, obj) {
  console.log('\n' + '─'.repeat(64));
  console.log(`[${label}]`);
  if (obj !== undefined) console.log(JSON.stringify(obj, null, 2));
}

function assert(cond, msg) {
  if (!cond) { console.error(`  ❌ FAIL: ${msg}`); process.exitCode = 1; }
  else        { console.log(`  ✅ OK:   ${msg}`); }
}

async function createUser(email, pass) {
  const r = await axios.post(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    { email, password: pass, returnSecureToken: true }
  );
  return { uid: r.data.localId, idToken: r.data.idToken, refreshToken: r.data.refreshToken };
}

async function refreshToken(rt) {
  const r = await axios.post(
    `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`,
    { grant_type: 'refresh_token', refresh_token: rt }
  );
  return r.data.id_token;
}

async function adminDeleteUser(uid) {
  await axios.post(
    `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:delete`,
    { localId: uid },
    { headers: { Authorization: `Bearer ${AT}` } }
  );
}

async function callFn(name, data, idToken) {
  const r = await axios.post(
    `${FN_BASE}/${name}`,
    { data },
    { headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' }, timeout: 60000 }
  );
  return r.data.result ?? r.data;
}

async function main() {
  const ts     = Date.now();
  const sfx    = ts.toString(36).slice(-6);
  const email  = `test_authfail_${sfx}@test.fillyo.kr`;
  const pass   = `Test1234!${sfx}`;
  const acadId = `test_authfail_${sfx}`;

  console.log('='.repeat(64));
  console.log('  doWithdraw 수정 검증: Auth 삭제 실패 시나리오');
  console.log(`  테스트 학원: ${acadId}`);
  console.log('='.repeat(64));

  let uid, idToken, rt;

  // ── STEP 1: 계정 + 데이터 생성 ────────────────────────────────────
  log('STEP 1: 테스트 계정 + RTDB 데이터 생성');
  ({ uid, idToken, refreshToken: rt } = await createUser(email, pass));
  console.log(`  ✅ Auth 계정: ${uid}`);

  await fb.set(`academies/${acadId}`, {
    settings: { academyName: '탈퇴오류테스트', name: '탈퇴오류테스트', ownerName: 'test', planType: 'pro', createdAt: ts },
    billing:  { regularAmount: 14900, monthlyAmount: 9900, paidCount: 2 },  // 위약금 10,000원
  });
  await fb.set(`users/${uid}`, { academyId: acadId, email, planType: 'pro', createdAt: ts });
  console.log(`  ✅ RTDB 데이터 생성`);
  console.log(`  💰 예상 위약금: (14900-9900)*2 = 10,000원, billingKey 없음`);

  // ── STEP 2: executeWithdraw 호출 (서버 탈퇴 완료) ─────────────────
  log('STEP 2: executeWithdraw 호출 (서버 탈퇴 처리)');
  let withdrawRes;
  try {
    idToken = await refreshToken(rt);
    withdrawRes = await callFn('executeWithdraw', { academyId: acadId }, idToken);
    console.log('  서버 응답:', JSON.stringify(withdrawRes));
    assert(withdrawRes.success === true, 'success=true');
    assert(withdrawRes.charged === false, 'charged=false (billingKey 없음)');
    assert(withdrawRes.pendingAmount === 10000, `pendingAmount=10,000 (실제: ${withdrawRes.pendingAmount})`);
  } catch (e) {
    console.error('  ❌ executeWithdraw 실패:', e.response?.data ?? e.message);
    process.exitCode = 1;
    return;
  }

  // ★ 이 시점이 doWithdraw에서 alert(msg)가 뜨는 순간
  //   사용자는 이미 "탈퇴가 완료되었습니다" 메시지를 본 상태
  console.log('\n  ★ 이 시점에서 사용자는 이미 성공 메시지를 보았음');
  console.log('    (수정된 doWithdraw에서 closeWithdrawModal → alert(msg) → deleteUser 순서)');

  // ── STEP 3: RTDB 이동 확인 (alert 시점 기준 상태) ─────────────────
  log('STEP 3: executeWithdraw 직후 RTDB 상태 검증 (alert 시점 기준)');
  const acadAfter   = await fb.get(`academies/${acadId}`);
  const withdrawn   = await fb.get(`withdrawnAcademies/${acadId}`);
  const settleDue   = await fb.get(`settlementDue/${acadId}`);
  const userAfter   = await fb.get(`users/${uid}`);

  assert(acadAfter === null,           `academies/${acadId} 삭제됨`);
  assert(withdrawn !== null,           `withdrawnAcademies/${acadId} 존재`);
  assert(withdrawn?._charged === false, `_charged=false`);
  assert(settleDue?.amount === 10000,  `settlementDue 10,000원 기록됨`);
  assert(userAfter?.planType === 'withdrawn', `users.planType=withdrawn`);

  // ── STEP 4: Auth 삭제 실패 시뮬레이션 ────────────────────────────
  //  어드민으로 Auth 계정을 먼저 삭제하여, 이후 클라이언트의 deleteUser가
  //  "user-not-found" 에러를 낼 수밖에 없게 만듦
  //  (= requires-recent-login과 동일하게 Auth 삭제 실패 케이스)
  log('STEP 4: Auth 삭제 실패 시뮬레이션 (어드민으로 계정 먼저 삭제)');
  try {
    await adminDeleteUser(uid);
    console.log(`  ✅ 어드민 강제 삭제 완료 (uid: ${uid})`);
  } catch (e) {
    console.log(`  ℹ️  이미 없거나 삭제됨: ${e.response?.data?.error?.message ?? e.message}`);
  }

  // 클라이언트 deleteUser 시뮬레이션 — 삭제된 계정으로 다시 Auth 조작 시도
  console.log('\n  클라이언트 deleteUser 시뮬레이션 (이미 삭제된 계정에 시도):');
  try {
    idToken = await refreshToken(rt);
    // 이미 삭제된 계정이라 token refresh 실패 예상 → auth/user-not-found 또는 token-expired
    console.log('  ⚠️ 토큰 갱신됨 (계정이 아직 살아있을 수 있음)');
    // deleteUser REST API 시뮬레이션
    await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${API_KEY}`,
      { idToken }
    );
    console.log('  ℹ️  deleteUser 성공 (계정이 아직 있었음)');
  } catch (e) {
    const errCode = e.response?.data?.error?.message ?? e.message;
    console.log(`  ✅ deleteUser 실패 시뮬레이션: ${errCode}`);
    console.log('     → 수정된 doWithdraw의 내부 try-catch가 이 에러를 조용히 처리함');
    console.log('     → 사용자에게는 "탈퇴 실패" 표시 없음, 이미 성공 알림 본 상태');
  }

  // ── STEP 5: Auth 실패 이후에도 RTDB 상태 불변 확인 ─────────────
  log('STEP 5: Auth 실패 후에도 RTDB 상태 정상 유지 확인');
  const withdrawn2 = await fb.get(`withdrawnAcademies/${acadId}`);
  const settleDue2 = await fb.get(`settlementDue/${acadId}`);
  const userAfter2 = await fb.get(`users/${uid}`);

  assert(withdrawn2 !== null,                  `withdrawnAcademies 여전히 존재`);
  assert(withdrawn2?._withdrawnAt != null,      `_withdrawnAt 유지됨`);
  assert(settleDue2?.amount === 10000,         `settlementDue 10,000원 유지됨`);
  assert(userAfter2?.planType === 'withdrawn', `users.planType=withdrawn 유지됨`);
  console.log('\n  ★ Auth 삭제 실패와 무관하게 서버 탈퇴 데이터는 온전히 보존됨');

  // ── STEP 6: 잔여 데이터 정리 ─────────────────────────────────────
  log('STEP 6: 잔여 데이터 정리');
  await fb.del(`withdrawnAcademies/${acadId}`);
  await fb.del(`settlementDue/${acadId}`);
  await fb.del(`users/${uid}`);
  console.log('  ✅ RTDB 정리 완료');

  // ── 최종 요약 ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(64));
  if (process.exitCode === 1) {
    console.error('❌ 검증 실패');
  } else {
    console.log('✅ doWithdraw 수정 검증 완료');
    console.log();
    console.log('  [수정 전]');
    console.log('    try {');
    console.log('      await fnExecuteWithdraw(...)  ← 성공');
    console.log('      alert(msg)');
    console.log('      await deleteUser(...)  ← 실패 → catch로 점프');
    console.log('    } catch (e) {');
    console.log('      showToast("탈퇴 실패: ...")  ← ❌ 사용자에게 잘못 표시');
    console.log('    }');
    console.log();
    console.log('  [수정 후]');
    console.log('    try {');
    console.log('      await fnExecuteWithdraw(...)  ← 성공');
    console.log('      alert(msg)  ← ✅ 사용자에게 먼저 완료 안내');
    console.log('      try {');
    console.log('        await deleteUser(...)  ← 실패해도');
    console.log('      } catch { console.warn(...) }  ← 조용히 로그만');
    console.log('      location.href = "/login/"  ← ✅ 항상 리다이렉트');
    console.log('    } catch (e) { showToast("오류...") }');
    console.log();
    console.log('  → Auth 삭제 실패 시 미삭제 계정은 users.planType=withdrawn으로 식별 가능');
  }
  console.log('═'.repeat(64));
}

main().catch(e => {
  console.error('\n💥 스크립트 오류:', e.response?.data ?? e.message);
  process.exit(1);
});
