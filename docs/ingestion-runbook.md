# 적재 개선 적용·운영 절차

## 현재 제공되는 변경

기존 6개 코인·5분 수집에서 공급자, 원천 표기 시각, fetch 시각과 환율 기준일을 보존한다. 새 관측은 기존 테이블과 provenance sidecar에 원자적으로 추가된다. 이미 저장된 같은 키와 과거 원천 불명 행은 수정하지 않는다. collector_runs는 시도별 성공·부분 성공·실패와 실제 신규 행 수를 기록한다.

테이블은 현재 ensureSchema 경로에서 존재 여부를 확인해 생성한다. 기존 premium_snapshots의 열과 가격 조회 API를 변경하는 마이그레이션은 없다. 코드 적용 후 처음 수집될 때부터 메타데이터가 생긴다. 과거 데이터에 대한 backfill은 수행하지 않는다. 테이블 생성조차 실패한 경우에는 로그를 확인해야 하며 실행 이력을 저장할 수 있다고 보장하지 않는다.

## 배포 주의

기준은 GitHub main 5be1f359이며 실제 운영 PC 폴더에는 이 저장소에 없는 랜딩·프리뷰·분석 변경이 있었다. 따라서 이 스냅샷을 통째로 deploy하지 않는다. 변경 파일만 실제 운영 브랜치에 병합해 기존 사용자 변경을 보존한 뒤 타입·회귀 검사와 dry-run을 수행한다.

현재 작업 환경에는 이전 Windows Cloudflare OAuth와 DART 키가 없다. 코드·로컬 테스트·Worker 번들 확인과 실제 운영 적용은 별개다. 이 변경에는 실제 배포나 원격 DB 생성이 포함되지 않았다. 배포용 계정 연결은 안전한 환경 설정에서 진행하며 비밀번호/토큰/키를 채팅에 붙여넣지 않는다.

## DART 파일럿 활성화 조건

현재 기본값은 비활성이다. 기존 무료·유료 엔드포인트에 DART 데이터가 노출되지 않는다.

1. 공식 사용 범위와 대상 회사(최대 10개)를 확인한다. 6자리 종목코드가 아니라 8자리 DART corp_code를 사용한다.
2. `DART_API_KEY`는 Worker secret으로 설정한다. 코드·vars·Git·URL 공유·로그에 값을 넣지 않는다.
3. `DART_ENABLED=true`, `DART_CORP_CODES=00126380,...`를 운영 환경에 설정한다. 위 숫자는 형식 예시이며 실제 감시 대상을 승인한 설정이 아니다.
4. 시작 전에 `runDartTick`을 스테이징에서 확인한다. 일일 실행을 원하면 cron `17 8 * * 1-5`(평일 17:17 KST)을 별도로 추가한다. 이번 변경은 해당 trigger를 자동 추가하지 않는다.
5. 키가 없거나 설정이 잘못되면 요청 전에 실패한다. 비활성 상태에서는 데이터 요청·DB 쓰기가 없다.

공시 목록 첫 실행은 최근 7일을 조회한다. 이후 회사별 마지막 완전 조회일에서 하루 겹쳐 이어간다. 장기 중단 때는 최대 7일 창으로 나누어 따라잡고, 남은 기간은 catch_up_pending으로 표시한다. 한 회사당 최대 3페이지(100개/페이지)이므로 상한에 걸리면 partial/page_limit이며 워터마크를 전진시키지 않는다. 반복해서 상한에 걸리면 검색 창을 줄이는 추가 운영 조치가 필요하다. 페이지 수가 바뀌거나 뒤 페이지가 갑자기 no-data가 되면 일관성 오류로 실패하고 저장하지 않는다.

접수번호가 다른 정정 공시는 별도 행이고, 원래 공시와의 관계를 제목만으로 추측하지 않는다. 같은 접수번호의 메타데이터가 A→B→A로 변하면 세 관측을 보존하고 revision_no와 previous_event_id로 연결한다. published_at은 원천에서 정밀 시각을 얻지 못해 null이며 publication_date와 first_observed_at은 다른 의미다. 원문 문서·제출인 개인정보는 수집하지 않는다. 여러 페이지 수집은 한 트랜잭션으로 저장하며 너무 큰 batch가 실제 D1 제한에 걸리면 실패로 남고 일부 저장을 성공으로 표시하지 않는다.

## 점검 명령

```sh
npm ci --ignore-scripts
npm run check
npm run test:ingestion
npx esbuild test/preview-and-history.test.ts --bundle --platform=node --format=esm --outfile=.wrangler/preview-tests.mjs
node --test .wrangler/preview-tests.mjs
npx wrangler deploy --env production --dry-run
```

실행 이력·미완료 실행·최근 provenance 비율은 scripts/ingestion-health.sql의 SELECT로 조회한다. DART 테이블은 활성 파일럿이 한 번 실행된 후에만 존재하므로 해당 조회를 따로 실행한다. 실행 이력에 없는 누락 run과 종료되지 못한 running run은 별개이며, running을 자동 success/failure로 덮어쓰지 않는다. 신규 수집 뒤 최근 7일 신선도·최대 공백·원천별 상태를 측정한다. 현재 데이터의 상업적 재배포 권한이 확보됐다는 뜻은 아니다.

## 검증 한계

테스트는 실제 SQLite 트랜잭션과 모의 API 응답으로 수행했다. 실제 DART 키로 응답·처리량을 검증하거나 현재 운영 DB에 배포해 쓰기 결과를 확인하지 않았다. API 오류에 키가 담겨도 외부 로그와 DB에는 분류 코드만 기록하도록 테스트했다. 수집 품질이 곧 외부 원본의 정확도나 상업 이용 허가를 의미하지 않는다.
