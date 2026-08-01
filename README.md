# K-Data x402

**AI 에이전트를 고객으로 하는 한국 데이터 유료 API.** 에이전트가 요청할 때마다 USDC 소액 결제가 발생합니다.

- **결제**: [x402 프로토콜](https://x402.org) — HTTP 402 기반, 계정·카드·API 키 없이 요청당 USDC 정산 (Base 체인)
- **호스팅**: Cloudflare Workers (무료 티어 10만 요청/일)
- **원가**: 키가 필요 없는 무료 공개 데이터만 사용 → 운영비 사실상 0
- **차별화**: 해외 에이전트가 직접 접근하기 번거로운 한국 시장·언론 데이터

## 왜 이 조합인가

x402는 2026년 현재 에이전트 결제의 사실상 표준입니다. 시장 조건도 유리합니다 —
구매자 4,400명 대비 판매자 477명이고, 데이터 카테고리가 전체 활동의 30.9%를 차지합니다.

다만 조사해보니 **거의 동일한 경쟁자**(kr-crypto-intelligence)와 Apify의 김프 트래커가 이미 존재합니다.
그래서 차별화를 세 가지로 좁혔습니다.

**1. 거래 가능한 기준의 김치프리미엄.** 모두가 공식 환율 기준 수치를 인용하지만, 한국의 자본통제 때문에
KRW 회수 경로는 실제로 USDT를 거칩니다. 즉 공식 수치는 거래할 수 없는 숫자입니다. 두 기준을 모두 반환하며,
**둘은 자주 부호가 반대**입니다 — 실측에서 공식 기준 -0.27%일 때 실현 가능 기준은 +0.19%였습니다.

**2. 과거 데이터와 백분위 맥락.** 경쟁자 둘 다 실시간 스냅샷만 팝니다. 5분마다 기록하는 아카이브는
"지금 이 프리미엄이 이례적인가"에 답하며, 사후에 복원할 수 없어 시간이 갈수록 벌어지는 해자입니다.

**3. 영어 번역된 한국 뉴스.** 언어 장벽이 이 니치의 본질인데, 원문만 주면 해외 에이전트에게 무용지물입니다.

## 엔드포인트

| Endpoint | 가격 | 내용 |
|---|---|---|
| `GET /api/kimchi-premium/stats` | $0.12 | 프리미엄 백분위·평균·표준편차·z점수 (1h~90d). "지금이 이례적인가"에 대한 답 |
| `GET /api/kimchi-premium/history` | $0.08 | 프리미엄 시계열 (양 기준) |
| `GET /api/korea/market-snapshot` | $0.08 | 번들: 김프 + 마켓 + 환율 + 영어 번역 뉴스 |
| `GET /api/news/headlines/en` | $0.05 | 한국 헤드라인 + 영어 번역 |
| `GET /api/kimchi-premium` | $0.03 | 김프 (공식 기준 + USDT 실거래 기준) |
| `GET /api/crypto/krw/markets` | $0.01 | 업비트 KRW 마켓 전체 스냅샷 |
| `GET /api/news/headlines` | $0.01 | 한국 헤드라인 (원문) |
| `GET /api/crypto/krw/:ticker` | $0.005 | 개별 코인 KRW 시세 |
| `GET /api/fx/usdkrw` | $0.005 | 원달러 환율 |

무료: `/` (랜딩) · `/api/catalog` · `/openapi.json` · `/llms.txt` · `POST /mcp` (도구 목록)

가격은 시장 평균 거래액($0.37)을 감안해 책정했습니다. 저가 엔드포인트는 유입용이고,
대체 불가능한 아카이브 기반 엔드포인트가 객단가를 담당합니다.

## 두 가지 접근 경로

같은 카탈로그·핸들러·가격을 REST와 MCP 두 전송으로 제공합니다.

- **REST** — 임의의 x402 클라이언트 (`@x402/fetch` 등)
- **MCP** — `POST /mcp` 호스팅형, 또는 설치형 [`k-data-mcp`](packages/k-data-mcp) npm 패키지

MCP 패키지는 시작 시 `/api/catalog`을 읽어 도구를 생성하므로, 서버에 엔드포인트를 추가하면
패키지 재배포 없이 도구가 늘어납니다.

## 구조

```
src/
  index.ts        라우팅 + x402 페이월 + cron(scheduled) 진입점
  catalog.ts      엔드포인트·가격·스키마의 단일 원천 (페이월/카탈로그/OpenAPI/랜딩/llms.txt/MCP가 모두 참조)
  handlers.ts     runEndpoint() — REST와 MCP가 공유하는 단일 실행 경로
  mcp.ts          MCP JSON-RPC 엔드포인트 (도구별 x402 과금)
  archive.ts      5분 주기 프리미엄 스냅샷 → D1
  lib/
    cache.ts          TTL 캐시 + fetch 헬퍼
    cdp-facilitator.ts  CDP JWT 인증 (Workers 네이티브 WebCrypto)
    translate.ts      한국어→영어 번역 + 수 단위 결정론적 전개
  sources/
    upbit.ts / global.ts / fx.ts / kimchi.ts / news.ts / history.ts
packages/
  k-data-mcp/     배포용 설치형 MCP 서버 (별도 npm 패키지)
test/
  smoke-sources.ts  데이터 소스 실 업스트림 검증
  agent-client.ts   "구매자 에이전트" 입장의 결제 E2E
```

가격·설명을 바꿀 때는 `src/catalog.ts` 한 곳만 고치면 페이월·카탈로그·OpenAPI·랜딩·llms.txt·MCP 도구에 동시 반영됩니다.

## 로컬 실행

```bash
npm install
```

```bash
npx wrangler dev
```

기본값은 Base Sepolia 테스트넷 + 무료 `x402.org` facilitator입니다.
유료 라우트를 결제 없이 호출하면 `402`와 함께 `PAYMENT-REQUIRED` 헤더(base64 JSON)로 결제 요구사항이 옵니다.

데이터 소스만 따로 검증:

```bash
npx esbuild test/smoke-sources.ts --bundle --format=esm --platform=node --outfile=.wrangler/tmp-smoke.mjs && node .wrangler/tmp-smoke.mjs
```

## 배포 및 실수익

지갑 주소·CDP 키 설정부터 실제 USDC 수취 검증까지는 [DEPLOY.md](DEPLOY.md)를 따르세요.

## 배포 현황

메인넷 가동 중: **https://k-data-x402-production.theblack1022.workers.dev**

- 무료 라우트 4개 200, 유료 라우트 9개 모두 402 + Base 메인넷 USDC 결제 요구사항 반환
- MCP 엔드포인트 `POST /mcp` — 도구 9개, 도구별 과금 확인
- 아카이브 cron 5분 주기 기록 중 (D1)
- 실거래 정산 1건 온체인 확인 (수취 지갑 USDC 입금)

## 다음 단계 — 에이전트 유입

유통 채널 등록은 계정이 필요해 [SUBMISSIONS.md](SUBMISSIONS.md)에 제출 원고를 정리해 뒀습니다.
공식 MCP Registry가 다른 디렉토리와 클라이언트의 피드 역할을 하므로 그것부터 등록하는 순서입니다.

## Workers 특이사항 (해결 완료, 재발 방지용 기록)

- **CDP facilitator 인증을 직접 구현했습니다** ([src/lib/cdp-facilitator.ts](src/lib/cdp-facilitator.ts)).
  `@coinbase/cdp-sdk`는 JWT 서명에 `jose`를 쓰는데, wrangler의 esbuild가 `jose`를 지연 초기화 모듈로 감싸면서
  호이스팅된 `isObject`가 아직 할당 안 된 `isObjectLike`를 참조해 모든 facilitator 호출이 죽었습니다
  (`isObjectLike is not a function`). JWT 자체는 단순하고 규격이 명확해서 Workers 네이티브 WebCrypto로
  직접 서명하고, SDK·jose·uncrypto를 번들에서 제거했습니다.
- **페이월은 첫 유료 요청 안에서 생성합니다.** `paymentMiddleware`는 생성 시점에 facilitator 동기화 fetch를
  시작하는데, Workers에서 그 I/O는 원래 요청이 끝나면 취소되어 이후 요청이 무한 대기합니다.
- **Bazaar discovery 확장의 Ajv 검증은 Workers에서 실패하지만 치명적이지 않습니다.** 미들웨어가 `.catch()`로
  감싸고 있어 시작 시 경고 한 줄만 남고, 선언 자체는 402 응답에 정상적으로 실려 나갑니다.
- 인메모리 캐시는 Worker 아이솔레이트 단위입니다. 트래픽이 커지면 Cache API나 KV로 옮기는 편이 좋습니다.
