# FILLYO — Claude Code 작업 지침

예체능 학원·체육도장(태권도 중심) 실무 기록 SaaS. 1인 운영(대표: 임명신, 코딩 지식 없음 — 모든 코드 작업은 Claude Code가 수행). 저장소: `tsrtkd/fillyo`, 배포: GitHub Pages → fillyo.kr

## 🚫 절대 규칙 (예외 없음)

1. **`taesarang-dojang` 저장소는 절대 건드리지 않는다.**
2. **실계정 데이터를 대상으로 파괴적 테스트 금지.** 보호 대상: `PROTECTED_ACADEMY_IDS`에 정의된 학원(태사랑태권도 등). 테스트는 반드시 `test_` 접두사가 붙은 계정/학원ID 또는 시험 도장 `ac_mv65z0ih4o10`(testfillyo@fillyo.kr)으로만 한다. 결제 시험은 `tsrtkd@naver.com`. 실결제 시험은 당일 취소가 가능하도록 밤 10시 전에 시작.
3. **폰트 크기·줄 간격(font-size, line-height)은 어떤 이유로도 수정하지 않는다.** 레이아웃이 깨져 보이면 원인은 대개 `li` 텍스트 줄바꿈이지 폰트 크기가 아니다.
4. `functions/.env`, API Secret, 웹훅 시크릿 등 비밀값은 **절대 커밋하지 않는다.** 커밋 전 `.gitignore`에 포함되어 있는지, 이미 추적 중인 파일이 아닌지 확인한다.
5. 결제 로직·AI 리포트 생성 로직 변경, 여러 파일 동시 수정, 기존 데이터에 영향 주는 작업은 **테스트 브랜치**를 먼저 만든다 (`git checkout -b fix/설명` 또는 `test/설명`). 단순 문구 수정은 바로 main 커밋 가능.
6. 작업 전 **로컬 캐시(`/mnt/project`, 이전 대화 요약 등)를 신뢰하지 않는다.** 항상 `git pull` 또는 GitHub raw로 파일의 현재 상태를 먼저 확인한 뒤 수정한다.
7. **"완료됐다"고 보고하기 전, 반드시 실제로 재확인한다.** 커밋 로그가 아니라 실제 파일 내용(`git show HEAD:파일경로`)과, 가능하면 실브라우저 스크린샷으로 검증한다. 캐시 지연으로 확인이 안 되면 "확인 안 됨"이라고 보고하지, "됐을 것"이라고 넘겨짚지 않는다.
8. 결제·접근권한처럼 실제 돈이나 데이터 접근이 걸린 기능은 **코드 리뷰만으로 "정상"이라 결론 내지 않는다.** 실브라우저로 전체 시나리오(성공/실패/경계 케이스)를 직접 실행해 확인한다.
9. **`migrateToSinglePlan`을 `dryRun:false`로 실행 금지.**
10. **`purgeWithdrawnData` 수동 실행 금지.** 제외 목록(`PROTECTED_ACADEMY_IDS`, `PURGE_EXTRA_EXCLUDED_IDS`) 수정 금지.
11. **서비스 계정 키(`serviceAccountKey.json`) 사용 금지.**
12. **개인정보가 담긴 데이터를 국외 리전에 새로 저장 금지.**
13. **데이터를 지우는 기능은 배포 전 삭제 대상 목록을 운영자에게 먼저 보고.**

## 작업 흐름

- 대표님은 코드를 모른다. 모든 지시는 이 채팅에서 자연어로 주고받는다. **전체 코드를 미리 다 짜서 보여주지 말고**, 무엇을 어떻게 바꿀지 지시를 받아 직접 수정한다.
- 작업 종료 시 항상: `git add -A && git commit -m "설명" && git push`
- 화면 디자인/레이아웃 변경은 `view` 도구(또는 스크린샷)로 실제 렌더링을 확인한 뒤에만 완료로 보고한다. 텍스트 diff만으로 "잘 됐다"고 하지 않는다.
- GitHub CLI(`gh`)가 인증 안 돼 있으면 PR을 자동 생성하지 못한다 — 이 경우 PR 생성 URL을 안내하고 사람이 직접 열게 한다.

## 인프라

- **Firebase**: 프로젝트 `fillyo-journal`, RTDB `asia-southeast1`, Blaze 요금제
- **결제**: PortOne V2 + 한국결제네트웍스(KPN, 퍼스트페이). storeId `store-0e6ce5fc-6728-436c-8ca5-bb0ba0e6ba4c`
  - 일반결제(단건, requestPayment) 실연동 채널: `channel-key-dab745e0-688d-45e7-b7d2-e648d528b826` (사용 여부 확인 필요)
  - 카드등록/빌링키 발급(issueBillingKey) 실연동 채널: `channel-key-94abf50e-2417-4672-9066-64f782818ffa`
  - 본인인증 전용 채널: `channel-key-23977342-b6d1-4033-a0fe-2149ee43a9e9` (사용 여부 확인 필요)
  - **웹훅 시크릿은 실연동 모드 값을 써야 한다.** 채널이 실연동으로 전환됐으므로 반드시 실연동 웹훅 시크릿으로 교체 확인할 것.
  - **결제 금액은 서버가 결정한다.** 첫 결제 성공 판정은 포트원 단건조회로 한다. 결제 성공 시 pro 전환은 서버(`scheduleNextPayment`)가 처리하고, 취소 시 free 전환은 웹훅(`portoneWebhook`)이 처리한다.
- **사업자정보**: 상호 필요(FILLYO), 대표 임명신, 사업자등록번호 776-51-01113, 대전광역시 서구 도안동로 77 린풀하우스 1812-2401, 010-6407-6273, audtls2g@gmail.com

## 서버·배포 규칙

- Functions 리전: `asia-northeast3`, Node.js 22.
- `firebase deploy`는 **반드시 `--only`를 붙인다.** `firebase.json`에 DB 규칙이 연결돼 있어 `--only` 없이 배포하면 DB 규칙까지 같이 배포된다.
- 화면(프론트엔드)은 GitHub Pages로 서빙된다. `main` 브랜치 병합으로 자동 반영되며, `firebase hosting` 배포는 하지 않는다.
- 서버(Functions)를 먼저 배포해도 화면이 깨지지 않는 순서로 작업한다. 배포(Functions deploy)와 화면 병합(main merge) 사이의 시간을 최소화한다.
- **Functions 배포 전에는 반드시 운영자 OK를 받는다.**

## DB 보안 규칙

- 현행 규칙 파일: `database.rules.json`. 이전 규칙 백업: `database.rules.backup-20261013.json`.
- 브라우저(클라이언트) 코드에서 아래 경로/필드를 직접 읽거나 쓰는 코드를 만들지 않는다 — 반드시 Functions를 통해서만 접근:
  `planType`, `planExpiry`, `role`, `billingKey`, `billingCycle`, `cancelledAt`, `withdrawnAt`, `academies/*/billing`, `payments`, `addons`
- **서버 전용 경로 (브라우저 완전 차단)**:
  `openPriceSlots`, `paymentOrders`, `withdrawnAcademies`, `retainedPaymentRecords`, `staffSecrets`, `staffRateLimit`, `aiCredits`
- **규칙 원리**: 상위 노드에서 허용하면 하위 `false`는 무효 → 하위 제한은 `.validate`로 건다.
- **규칙 변경 절차**: 테스트 브랜치 → `test/rules_test.js` 에뮬레이터(`firebase emulators:exec --only database --project demo-fillyo`) → 실브라우저 확인 → `firebase deploy --only database`

## 가격 구조 (단일 요금제, 2026.9.29 개편)

| 상품 | 오픈기념가 | 정가 |
|---|---|---|
| FILLYO 전체 (업무일지+AI성장리포트+줄넘기+승급심사) | 9,900원/월 (선착순 50개 도장, 가입 시 평생 고정) | 19,900원/월 |

- 약정 없음, 위약금 없음. 매월 자동결제, 언제든 해지 가능.
- 무료체험: 3개월(90일). 카드 등록 없이 시작.
- 해지 후에도 이미 결제한 기간까지 이용 가능.
- **전액 환불 시 즉시 이용 종료.** 남은 체험 기간이 있으면 체험으로 복귀.
- **AI 성장리포트**: 매달(한국시간 기준) 무료 30건. 서버 전용 `aiCredits/{academyId}`에서 집계. 생성 1회 = 1건, 실패 시 환불, 관리자는 무제한. 충전(50건 5,000원 / 100건 10,000원, 유효기간 1년)은 준비 중.

## 자동저장 규칙 (app/index.html, 업무일지)

- 입력 멈춘 후 **2.5초(2500ms)** 뒤 자동저장되는 필드: 특이사항·행사·미팅·교육·상담 텍스트, 관장 입관·복관·퇴관 메모, 부별 출석 인원, 결석자 이름/사유
- **자동저장 안 되는 필드**: "기준총원"(이달 인원 변동 등록 섹션) — 별도 저장 버튼 필요. 신규/복관/퇴관 숫자는 일별 기록에서 자동 계산되는 표시값이라 직접 입력 불가.

## 사이트 구조

`/` 랜딩 · `/login/` 로그인·가입 · `/dashboard/` 대시보드 · `/mypage/` 구독 관리 · `/app/` 업무일지 · `/exam/` 승급심사 · `/jumprope/` 줄넘기 · `/report/` AI성장리포트 · `/slowmo/` 슬로우모션(무료) · `/policy/` 지원정책(무료) · `/guide/` 사용설명서 · `/admin/` 관리자 · `/setup/` 온보딩 · `/terms/` `/privacy/` `/refund/` 법적 문서 · `/pricing/` 요금제 안내 · `/staff/` 직원 입장 코드 화면(차량기사·도우미용, 가입 없이 6자리 코드 입력, DB 직접 접근 없이 Functions만 호출, 관장님은 대시보드 "직원 관리"에서 추가·재발급·삭제)

AI성장리포트는 업무일지 텍스트(특이사항·상담)에서 **학생 이름이 정확히 포함된 문자열만** 매칭해서 가져온다 (부분 문자열 매칭, `d.event.includes(studentName)`) — 이름 없이 적힌 기록은 리포트에 반영되지 않는다.

## 도메인 용어

- **애드온(구버전)**: 구버전 분리 요금제 시절 존재하던 개념. 현재는 모든 기능이 단일 요금에 통합됨. admin에서는 "(구버전)" 표기 유지.
- **기준총원**: 그달 시작 시점의 원생 총원 기준값. 신규/복관/퇴관 자동계산의 기준선.
