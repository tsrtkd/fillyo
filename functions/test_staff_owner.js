'use strict';
/**
 * _resolveOwnerUid 순수 로직 테스트
 * 실행: node functions/test_staff_owner.js
 */

const assert = require('assert');

// ── _resolveOwnerUid 인라인 구현 (index.js와 동일) ─────────────────
async function _resolveOwnerUid(academyId, callerUid, dbStub) {
  const snap = await dbStub.members(academyId);
  if (snap !== null) {
    const entry = Object.entries(snap).find(([, v]) => v === 'owner');
    if (entry) return entry[0];
  }
  if (callerUid) {
    const userAcId = await dbStub.userAcademyId(callerUid);
    if (userAcId === academyId) return callerUid;
  }
  return null;
}

// ── 테스트 케이스 ──────────────────────────────────────────────────
async function runTests() {
  let pass = 0;
  let fail = 0;
  const ok  = (label) => { console.log(`  ✓ ${label}`); pass++; };
  const ng  = (label, e) => { console.log(`  ✗ ${label}: ${e.message}`); fail++; };

  // Case 1: members에 owner 있음 → owner uid 반환
  try {
    const db = {
      members: async () => ({ uid_owner: 'owner', uid_other: 'member' }),
      userAcademyId: async () => null,
    };
    const result = await _resolveOwnerUid('ac_test', 'uid_caller', db);
    assert.strictEqual(result, 'uid_owner');
    ok('members에 owner 있음 → owner uid 반환');
  } catch (e) { ng('members에 owner 있음', e); }

  // Case 2: members null, callerUid academyId 일치 → callerUid 반환
  try {
    const db = {
      members: async () => null,
      userAcademyId: async (uid) => uid === 'uid_owner' ? 'ac_taesarang' : null,
    };
    const result = await _resolveOwnerUid('ac_taesarang', 'uid_owner', db);
    assert.strictEqual(result, 'uid_owner');
    ok('members null + callerUid 소유자 → callerUid 반환 (태사랑 케이스)');
  } catch (e) { ng('members null + callerUid 소유자', e); }

  // Case 3: members null, callerUid가 다른 academy → null
  try {
    const db = {
      members: async () => null,
      userAcademyId: async () => 'ac_other',
    };
    const result = await _resolveOwnerUid('ac_taesarang', 'uid_admin', db);
    assert.strictEqual(result, null);
    ok('members null + callerUid 불일치 → null (관리자 case)');
  } catch (e) { ng('members null + callerUid 불일치', e); }

  // Case 4: callerUid null (admin case) + members null → null
  try {
    const db = {
      members: async () => null,
      userAcademyId: async () => { throw new Error('should not be called'); },
    };
    const result = await _resolveOwnerUid('ac_taesarang', null, db);
    assert.strictEqual(result, null);
    ok('callerUid null + members null → null (skip ② 검사)');
  } catch (e) { ng('callerUid null + members null', e); }

  // Case 5: members 있으나 owner 없음, callerUid 일치 → callerUid
  try {
    const db = {
      members: async () => ({ uid_a: 'member', uid_b: 'member' }),
      userAcademyId: async (uid) => uid === 'uid_owner' ? 'ac_test' : null,
    };
    const result = await _resolveOwnerUid('ac_test', 'uid_owner', db);
    assert.strictEqual(result, 'uid_owner');
    ok('members에 owner role 없음 + callerUid 일치 → callerUid');
  } catch (e) { ng('members에 owner role 없음 + callerUid 일치', e); }

  console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
  if (fail > 0) process.exit(1);
}

runTests().catch(e => { console.error(e); process.exit(1); });
