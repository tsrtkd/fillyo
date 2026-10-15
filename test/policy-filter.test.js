'use strict';
// policy/index.html 필터 로직 검증 테스트
// 실행: node test/policy-filter.test.js

// ── 1. 주소 → 시·도 짧은 이름 ──────────────────────────────────────
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

// ── 2. 키워드 매칭 ─────────────────────────────────────────────────
const FILTER_KEYWORDS = [
  '소상공인', '자영업', '학원', '체육시설', '체육', '스포츠', '태권도',
  '고용', '경영안정', '정책자금', '바우처',
];
const EXCLUDE_KEYWORDS = ['게임', '방송영상', '모빌리티', '원전', '핀테크', '대체식품'];

function matchesKeyword(item) {
  const hay = ((item.pblancNm || '') + ' ' + (item.hashtags || '')).toLowerCase();
  if (EXCLUDE_KEYWORDS.some(kw => hay.includes(kw.toLowerCase()))) return false;
  return FILTER_KEYWORDS.some(kw => hay.includes(kw.toLowerCase()));
}

// ── 3. 지역 필터 ───────────────────────────────────────────────────
const ALL_SIDO = ['서울','부산','대구','인천','광주','대전','울산','세종','경기','강원','충북','충남','전북','전남','경북','경남','제주'];

function isNational(item) {
  const h = item.hashtags || '';
  return ALL_SIDO.filter(s => h.includes(s)).length >= 6;
}

// sido=null 이어도 지역 공고는 숨긴다 (전국 공고만 통과)
function isOtherRegion(item, sido) {
  if (isNational(item)) return false;

  const title = item.pblancNm    || '';
  const org   = item.jrsdInsttNm || '';

  const m = title.match(/^\[([^\]]+)\]/);
  if (m) {
    const b = m[1];
    if (sido && b.includes(sido)) return false;    // 내 지역 → 통과
    if (ALL_SIDO.some(s => b.includes(s))) return true;  // 대괄호에 어느 지역이든 → 숨김
  }

  const LOCAL_ORG = /(서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|경기도|강원특별자치도|충청북도|충청남도|전라북도|전북특별자치도|전라남도|경상북도|경상남도|제주특별자치도)/;
  if (LOCAL_ORG.test(org)) {
    if (sido && org.includes(sido)) return false;  // 내 지역 기관 → 통과
    return true;  // 다른 지역 기관 (sido 없을 때도 숨김)
  }

  return false;
}

// ── 테스트 실행 ─────────────────────────────────────────────────────
let pass = 0, fail = 0;
function assert(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) console.log(`   기대: ${expected}  실제: ${actual}`);
  ok ? pass++ : fail++;
}

console.log('\n=== 주소 → 시·도 변환 ===');
assert('대전광역시 서구 도안동로 77',  extractSido('대전광역시 서구 도안동로 77'), '대전');
assert('대전시 유성구 가정로',          extractSido('대전시 유성구 가정로'), '대전');
assert('서울특별시 강남구',             extractSido('서울특별시 강남구'), '서울');
assert('서울시 마포구',                 extractSido('서울시 마포구'), '서울');
assert('부산광역시 해운대구',           extractSido('부산광역시 해운대구'), '부산');
assert('경상북도 포항시',               extractSido('경상북도 포항시'), '경북');
assert('경상남도 창원시',               extractSido('경상남도 창원시'), '경남');
assert('전라북도 전주시',               extractSido('전라북도 전주시'), '전북');
assert('전라남도 목포시',               extractSido('전라남도 목포시'), '전남');
assert('충청북도 청주시',               extractSido('충청북도 청주시'), '충북');
assert('충청남도 천안시',               extractSido('충청남도 천안시'), '충남');
assert('광주광역시 서구',               extractSido('광주광역시 서구'), '광주');
assert('세종특별자치시 어진동',         extractSido('세종특별자치시 어진동'), '세종');
assert('제주특별자치도 제주시',         extractSido('제주특별자치도 제주시'), '제주');
assert('강원특별자치도 춘천시',         extractSido('강원특별자치도 춘천시'), '강원');
assert('null 입력',                     extractSido(null), null);
assert('빈 문자열',                     extractSido(''), null);

console.log('\n=== 키워드 매칭 ===');
assert('소상공인 포함 제목',    matchesKeyword({ pblancNm: '2026년 소상공인 경영안정 지원' }), true);
assert('체육 포함 hashtags',    matchesKeyword({ pblancNm: '지원사업', hashtags: '체육,스포츠' }), true);
assert('학원 포함 제목',        matchesKeyword({ pblancNm: '학원 운영 지원' }), true);
assert('태권도 포함 hashtags',  matchesKeyword({ pblancNm: '기타', hashtags: '태권도,도장' }), true);
assert('고용 포함',             matchesKeyword({ pblancNm: '청년 신규고용 인건비 지원', hashtags: '고용' }), true);
assert('바우처 포함',           matchesKeyword({ pblancNm: '경영안정 바우처 지원사업' }), true);
assert('원전 → 제외',           matchesKeyword({ pblancNm: '원전 해체 전문 인력 모집', hashtags: '원전' }), false);
assert('핀테크 → 제외',         matchesKeyword({ pblancNm: '2026 핀테크 스타트업 지원', hashtags: '핀테크,금융' }), false);
assert('대체식품 → 제외',       matchesKeyword({ pblancNm: '대체식품 기업 R&D 지원', hashtags: '식품,바이오' }), false);
assert('게임 → 제외',           matchesKeyword({ pblancNm: '게임사 현장교육', hashtags: '게임,인력' }), false);
assert('방송영상 → 제외',       matchesKeyword({ pblancNm: '방송영상콘텐츠 후반작업', hashtags: '방송영상' }), false);

console.log('\n=== 전국 공고 판정 ===');
const allSidoHash = '서울,부산,대구,인천,광주,대전,울산,세종,경기,강원,충북,충남,전북,전남,경북,경남,제주';
assert('17개 시도 모두 있음 → 전국', isNational({ hashtags: allSidoHash }), true);
assert('6개 시도 포함 → 전국',       isNational({ hashtags: '서울,부산,대구,인천,광주,대전' }), true);
assert('5개 이하 → 지역',            isNational({ hashtags: '부산,대구,인천,광주,대전' }), false);
assert('해시태그 없음 → 지역',       isNational({ hashtags: '' }), false);

console.log('\n=== 지역 필터 (mySido=대전) ===');
assert('[대전] 제목 → 내 지역',            isOtherRegion({ pblancNm: '[대전] 소상공인 지원',     jrsdInsttNm: '대전시',        hashtags: '대전' }, '대전'), false);
assert('[대전ㆍ세종] → 내 지역',           isOtherRegion({ pblancNm: '[대전ㆍ세종] 지역 공고',   jrsdInsttNm: '대전시',        hashtags: '대전' }, '대전'), false);
assert('[울산] → 다른 지역',               isOtherRegion({ pblancNm: '[울산] 지원사업',          jrsdInsttNm: '울산광역시',    hashtags: '울산' }, '대전'), true);
assert('[부산] → 다른 지역',               isOtherRegion({ pblancNm: '[부산] 소상공인 페어',     jrsdInsttNm: '부산광역시',    hashtags: '부산' }, '대전'), true);
assert('[경남] → 다른 지역',               isOtherRegion({ pblancNm: '[경남] 산재예방 공고',     jrsdInsttNm: '경상남도',      hashtags: '경남' }, '대전'), true);
assert('중앙부처 → 통과',                  isOtherRegion({ pblancNm: '소상공인 정책자금',        jrsdInsttNm: '중소벤처기업부',hashtags: '소상공인' }, '대전'), false);
assert('고용노동부 → 통과',                isOtherRegion({ pblancNm: '고용창출장려금',           jrsdInsttNm: '고용노동부',    hashtags: '고용' }, '대전'), false);
assert('전국 공고(17시도 hash) → 통과',    isOtherRegion({ pblancNm: '소상공인 지원',            jrsdInsttNm: '소상공인진흥공단', hashtags: allSidoHash }, '대전'), false);
assert('부산광역시 기관 → 다른 지역',      isOtherRegion({ pblancNm: '지원사업',                jrsdInsttNm: '부산광역시',    hashtags: '부산' }, '대전'), true);
assert('강원특별자치도 기관 → 다른 지역',  isOtherRegion({ pblancNm: '모빌리티 지원',           jrsdInsttNm: '강원특별자치도',hashtags: '강원' }, '대전'), true);
assert('대전광역시 기관 → 내 지역',        isOtherRegion({ pblancNm: '대전 소상공인 지원',      jrsdInsttNm: '대전광역시',    hashtags: '대전' }, '대전'), false);

console.log('\n=== 지역 필터 (mySido=null, 주소 없음) ===');
assert('[부산] 공고 → 차단',          isOtherRegion({ pblancNm: '[부산] 소상공인 페어',     jrsdInsttNm: '부산광역시',    hashtags: '부산' }, null), true);
assert('[서울] 공고 → 차단',          isOtherRegion({ pblancNm: '[서울] 경영주치의',        jrsdInsttNm: '서울특별시',    hashtags: '서울' }, null), true);
assert('[전북] 공고 → 차단',          isOtherRegion({ pblancNm: '[전북] 소상공인 지원',     jrsdInsttNm: '전라북도',      hashtags: '전북' }, null), true);
assert('[경기] 공고 → 차단',          isOtherRegion({ pblancNm: '[경기] 고용지원',          jrsdInsttNm: '경기도',        hashtags: '경기' }, null), true);
assert('[대전] 공고도 → 차단',        isOtherRegion({ pblancNm: '[대전] 소상공인 지원',     jrsdInsttNm: '대전시',        hashtags: '대전' }, null), true);
assert('중앙부처 → 통과',             isOtherRegion({ pblancNm: '소상공인 정책자금',        jrsdInsttNm: '중소벤처기업부',hashtags: '소상공인' }, null), false);
assert('소상공인시장진흥공단 → 통과', isOtherRegion({ pblancNm: '경영안정 바우처',          jrsdInsttNm: '소상공인시장진흥공단', hashtags: '소상공인' }, null), false);
assert('고용노동부 → 통과',           isOtherRegion({ pblancNm: '고용창출장려금',           jrsdInsttNm: '고용노동부',    hashtags: '고용' }, null), false);
assert('전국 공고(17시도 hash) → 통과', isOtherRegion({ pblancNm: '소상공인 지원',          jrsdInsttNm: '소상공인진흥공단', hashtags: allSidoHash }, null), false);
assert('부산광역시 기관만 있어도 → 차단', isOtherRegion({ pblancNm: '지원사업',            jrsdInsttNm: '부산광역시',    hashtags: '소상공인' }, null), true);

console.log(`\n결과: ${pass}건 통과, ${fail}건 실패\n`);
if (fail > 0) process.exit(1);
