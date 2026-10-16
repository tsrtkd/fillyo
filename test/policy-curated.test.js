'use strict';
// 추천정책 지역 거르기 · endDate 우선 마감일 · D-day 검증
// 실행: node test/policy-curated.test.js

// ── 주소 → 시·도 (policy/index.html 과 동일) ──────────────────────
function extractSido(address) {
  if (!address) return null;
  const addr = address.trim();
  const map = [
    [/(서울)/, '서울'], [/(부산)/, '부산'], [/(대구)/, '대구'],
    [/(인천)/, '인천'], [/(광주)/, '광주'], [/(대전)/, '대전'],
    [/(울산)/, '울산'], [/(세종)/, '세종'], [/(경기)/, '경기'],
    [/(강원)/, '강원'], [/(충북|충청북)/, '충북'], [/(충남|충청남)/, '충남'],
    [/(전북|전라북)/, '전북'], [/(전남|전라남)/, '전남'],
    [/(경북|경상북)/, '경북'], [/(경남|경상남)/, '경남'], [/(제주)/, '제주'],
  ];
  for (const [re, short] of map) {
    if (re.test(addr)) return short;
  }
  return null;
}

// ── 추천정책 지역 거르기 ───────────────────────────────────────────
function isCuratedVisible(item, sido, admin) {
  if (admin) return true;
  const r = (item.region || '').trim();
  if (!r || r === '전국') return true;
  if (!sido) return false;
  return r === sido;
}

// ── 마감일 추출 (endDate 우선) ─────────────────────────────────────
function getEndDate(item) {
  if (item.endDate)    return item.endDate;
  if (item.reqstEndDt) return item.reqstEndDt;
  const s = item.reqstBeginEndDe || '';
  const parts = s.split(' ~ ');
  return parts.length === 2 ? parts[1].trim() : null;
}

// ── D-day 계산 ─────────────────────────────────────────────────────
function calcDday(endDateStr) {
  if (!endDateStr) return null;
  const normalized = endDateStr.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  const end = new Date(normalized);
  if (isNaN(end.getTime())) return null;
  const now = new Date(); now.setHours(0,0,0,0); end.setHours(0,0,0,0);
  return Math.ceil((end - now) / (1000 * 60 * 60 * 24));
}

// ── 테스트 헬퍼 ────────────────────────────────────────────────────
let pass = 0, fail = 0;
function assert(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) console.log(`   기대: ${JSON.stringify(expected)}  실제: ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
}

// ── isCuratedVisible: 지역 거르기 ─────────────────────────────────
console.log('\n=== isCuratedVisible: 지역 거르기 ===');
assert('대전 관장님 · region=대전 → 보임',    isCuratedVisible({region:'대전'}, '대전', false), true);
assert('대전 관장님 · region=서울 → 숨김',    isCuratedVisible({region:'서울'}, '대전', false), false);
assert('대전 관장님 · region=전국 → 보임',    isCuratedVisible({region:'전국'}, '대전', false), true);
assert('대전 관장님 · region 없음 → 보임',    isCuratedVisible({},             '대전', false), true);
assert('서울 관장님 · region=대전 → 숨김',    isCuratedVisible({region:'대전'}, '서울', false), false);
assert('주소 없음   · region=대전 → 숨김',    isCuratedVisible({region:'대전'}, null,   false), false);
assert('주소 없음   · region=전국 → 보임',    isCuratedVisible({region:'전국'}, null,   false), true);
assert('주소 없음   · region 없음 → 보임',    isCuratedVisible({},             null,   false), true);
assert('관리자      · region=대전 · sido=null → 보임', isCuratedVisible({region:'대전'}, null,   true),  true);
assert('관리자      · region=서울 · sido=대전 → 보임', isCuratedVisible({region:'서울'}, '대전', true),  true);

// ── extractSido ────────────────────────────────────────────────────
console.log('\n=== extractSido ===');
assert('대전광역시 서구 도안동로 77', extractSido('대전광역시 서구 도안동로 77'), '대전');
assert('서울특별시 강남구',           extractSido('서울특별시 강남구'),           '서울');
assert('부산 해운대구',               extractSido('부산 해운대구'),               '부산');
assert('null 입력',                   extractSido(null),                          null);
assert('빈 문자열',                   extractSido(''),                            null);

// ── getEndDate: endDate 우선 순서 ─────────────────────────────────
console.log('\n=== getEndDate: endDate 우선 순서 ===');
assert('endDate만  → endDate 반환',
  getEndDate({endDate:'2026-12-31'}), '2026-12-31');
assert('reqstEndDt만 → reqstEndDt 반환',
  getEndDate({reqstEndDt:'2026-11-30'}), '2026-11-30');
assert('둘 다 있으면 endDate 우선',
  getEndDate({endDate:'2026-12-31', reqstEndDt:'2026-10-01'}), '2026-12-31');
assert('reqstBeginEndDe에서 파싱',
  getEndDate({reqstBeginEndDe:'2026.02.09 ~ 2026.12.18'}), '2026.12.18');
assert('아무것도 없으면 null',
  getEndDate({}), null);

// ── endDate 기준 마감 판정 ─────────────────────────────────────────
console.log('\n=== endDate 기준 마감 판정 ===');
const dPast   = calcDday(getEndDate({endDate:'2020-01-01'}));
assert('endDate 과거 → 음수 D-day (마감)',  dPast !== null && dPast < 0,   true);

const dFuture = calcDday(getEndDate({endDate:'2099-12-31'}));
assert('endDate 미래 → 양수 D-day',         dFuture !== null && dFuture > 0, true);

assert('날짜 없음 → null (상시)',            calcDday(getEndDate({})), null);

// reqstEndDt만 있는 항목도 마감 판정되는지
const dReqst  = calcDday(getEndDate({reqstEndDt:'2020-06-15'}));
assert('reqstEndDt 과거 → 음수 D-day',      dReqst !== null && dReqst < 0, true);

// ── 결과 출력 ─────────────────────────────────────────────────────
console.log(`\n결과: ${pass}개 통과, ${fail}개 실패\n`);
if (fail > 0) process.exit(1);
