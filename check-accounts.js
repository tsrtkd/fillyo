'use strict';
/**
 * check-accounts.js — 4개 계정의 Firebase Auth + academies 데이터 조회 (읽기 전용)
 * 사용법: node check-accounts.js
 */

const axios   = require('./functions/node_modules/axios');
const tools   = require('C:/Users/뿌이/.config/configstore/firebase-tools.json');
const AT      = tools.tokens.access_token;
const DB_BASE = 'https://fillyo-journal-default-rtdb.asia-southeast1.firebasedatabase.app';
const API_KEY = 'AIzaSyBL5lQr2VIPK9caokm90g4_eQIkA8EXjqE';
const PROJECT = 'fillyo-journal';

const EMAILS = [
  'test-free@fillyo.kr',
  'tsr@fillyo.kr',
  'test@fillyo.kr',
  'audtls2g@naver.com',
];

const fb = {
  get: (path) =>
    axios.get(`${DB_BASE}/${path}.json`, { params: { access_token: AT } })
      .then(r => r.data)
      .catch(() => null),
};

async function lookupAuthByEmail(email) {
  try {
    // Firebase Auth REST API (Admin scope via OAuth token)
    const res = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`,
      { email: [email] },
      { headers: { Authorization: `Bearer ${AT}`, 'Content-Type': 'application/json' } }
    );
    const users = res.data?.users || [];
    if (users.length === 0) return null;
    return {
      uid:          users[0].localId,
      email:        users[0].email,
      emailVerified: users[0].emailVerified,
      disabled:     users[0].disabled,
      createdAt:    users[0].createdAt ? new Date(Number(users[0].createdAt)).toISOString().slice(0, 10) : null,
      lastLoginAt:  users[0].lastLoginAt ? new Date(Number(users[0].lastLoginAt)).toISOString().slice(0, 10) : null,
    };
  } catch (e) {
    return { error: e.response?.data?.error?.message ?? e.message };
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('  4개 계정 Firebase Auth + academies 조회 (읽기 전용)');
  console.log(`  조회 시각: ${new Date().toISOString()}`);
  console.log('='.repeat(70));

  const results = [];

  for (const email of EMAILS) {
    const auth = await lookupAuthByEmail(email);
    let userData = null;
    let academyData = null;
    let academyId = null;

    if (auth && !auth.error && auth.uid) {
      userData  = await fb.get(`users/${auth.uid}`);
      academyId = userData?.academyId || null;
      if (academyId) {
        const settings = await fb.get(`academies/${academyId}/settings`);
        const billing  = await fb.get(`academies/${academyId}/billing`);
        academyData = {
          academyId,
          name:       settings?.academyName || settings?.name || '(이름 없음)',
          planType:   userData?.planType || settings?.planType || '?',
          hasBillingKey: !!(billing?.billingKey),
          billingKeyShort: billing?.billingKey ? billing.billingKey.slice(0, 8) + '...' : null,
          addons:     await fb.get(`academies/${academyId}/addons`),
        };
      }

      // withdrawn 확인
      const withdrawn = await fb.get(`withdrawnAcademies/${academyId}`);
      if (withdrawn) academyData = { ...academyData, withdrawn: true };
    }

    results.push({ email, auth, userData, academyData });
  }

  // 표 출력
  console.log('\n[Firebase Auth 상태]');
  console.log('-'.repeat(70));
  for (const r of results) {
    const a = r.auth;
    if (!a)             console.log(`❌ ${r.email.padEnd(28)} — Auth 계정 없음`);
    else if (a.error)   console.log(`⚠️  ${r.email.padEnd(28)} — 조회 실패: ${a.error}`);
    else                console.log(`✅ ${r.email.padEnd(28)} uid=${a.uid}  disabled=${a.disabled}  created=${a.createdAt}`);
  }

  console.log('\n[academies 데이터 상태]');
  console.log('-'.repeat(70));
  for (const r of results) {
    if (!r.academyData) {
      console.log(`❓ ${r.email.padEnd(28)} — academyId 없음 또는 Auth 없음`);
      continue;
    }
    const d = r.academyData;
    const addonKeys = d.addons ? Object.keys(d.addons).filter(k => d.addons[k]?.status === 'active') : [];
    console.log(`✅ ${r.email.padEnd(28)} academyId=${d.academyId}`);
    console.log(`   학원명=${d.name}  planType=${d.planType}  billingKey=${d.hasBillingKey ? d.billingKeyShort : '없음'}`);
    console.log(`   활성 애드온: ${addonKeys.length > 0 ? addonKeys.join(', ') : '없음'}${d.withdrawn ? '  ⚠️ withdrawnAcademies에도 존재' : ''}`);
  }

  console.log('\n[상세 JSON]');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => {
  console.error('오류:', e.message);
  process.exit(1);
});
