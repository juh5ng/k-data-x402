# 배포 가이드 — 실제 수익 발생까지

로컬 검증은 끝났습니다. 아래는 **당신이 직접 해야 하는 단계**(계정 생성·키 발급·지갑)와 그 다음 배포 절차입니다.
보안상 계정 생성과 키/시크릿 입력은 제가 대신 하지 않습니다.

---

## 1단계: Cloudflare 계정 연결

```bash
npx wrangler login
```

브라우저가 열리면 Cloudflare 계정으로 승인합니다. 계정이 없으면 무료로 가입하면 됩니다
(Workers 무료 티어: 10만 요청/일 — MVP에는 충분).

---

## 2단계: CDP(Coinbase Developer Platform) API 키 발급

x402 Bazaar 자동 등록과 Base **메인넷** 정산을 위해 필요합니다.

1. https://portal.cdp.coinbase.com 에서 계정 생성
2. **API Keys** → **Create API Key** (Secret API Key)
3. `API Key ID`와 `API Key Secret`을 안전한 곳에 복사 (Secret은 한 번만 표시됩니다)

> 테스트넷만 쓸 거라면 이 단계는 건너뛰어도 됩니다. 그 경우 무료 `x402.org/facilitator`가 쓰이지만,
> **Bazaar 자동 등록이 안 되고 실제 USDC 수익도 발생하지 않습니다.**

---

## 3단계: 수취 지갑 주소 설정

USDC를 받을 **본인 EVM 지갑 주소**(MetaMask 등)를 `wrangler.jsonc`의 production 환경에 넣습니다.

```jsonc
"env": {
  "production": {
    "vars": {
      "NETWORK": "eip155:8453",
      "PAY_TO": "0xYOUR_WALLET_ADDRESS_HERE",   // ← 여기
      "SERVICE_URL": "https://k-data-x402.<your-subdomain>.workers.dev"
    }
  }
}
```

> **프라이빗 키는 절대 넣지 마세요.** 수취에는 주소만 있으면 됩니다.

`SERVICE_URL`은 첫 배포 후 실제 URL을 확인해서 채우고 재배포하면 됩니다.

---

## 4단계: CDP 시크릿 등록

```bash
npx wrangler secret put CDP_API_KEY_ID --env production
```

```bash
npx wrangler secret put CDP_API_KEY_SECRET --env production
```

각 명령 실행 후 값을 붙여넣습니다. 시크릿은 Cloudflare에 암호화 저장되며 코드/레포에는 남지 않습니다.

---

## 5단계: 배포

```bash
npx wrangler deploy --env production
```

출력되는 `https://k-data-x402.<subdomain>.workers.dev` URL을 확인하고,
3단계의 `SERVICE_URL`에 채운 뒤 한 번 더 배포하세요.

---

## 6단계: 부트스트랩 결제 1건 — 남은 단 하나의 단계

이게 지금 유일하게 남은 작업이고, **수익 검증과 디스커버리를 동시에 해결합니다.**

x402 생태계에서 서비스가 카탈로그에 오르는 조건은 서버 설정이 아니라 **실제 정산 1건**입니다.
공식 문서 표현대로 "서버 선언만으로는 아무것도 등록되지 않습니다" — 결제가 한 번 정산돼야
x402scan(온체인 정산을 자동 인덱싱)과 x402 Bazaar에 노출되고, 그때부터 다른 에이전트가 찾아올 수 있습니다.

준비물: Base 네트워크에 **USDC 약 $1**이 있는 지갑. **ETH(가스)는 필요 없습니다** —
x402 exact 스킴에서 구매자는 EIP-3009 서명만 하고(오프체인), 온체인 제출과 가스는 facilitator가 부담합니다.

> **반드시 새로 만든 별도 지갑을 쓰세요.** 이 명령에는 결제자의 **프라이빗 키**가 들어가고,
> 셸 히스토리와 환경변수에 노출됩니다. 평소 쓰는 메인 지갑 키는 절대 쓰지 마세요.
> 수취 지갑(`0x519c...0C81`)과도 달라야 합니다 — 자기 자신에게 결제하는 꼴이 됩니다.
>
> MetaMask에서 **계정 추가** → 새 주소 생성 → 그 주소로 USDC $1~2를 Base 네트워크로 전송 →
> **계정 세부정보 → 프라이빗 키 표시**로 그 새 계정의 키만 사용하세요.

빌드:

```bash
npx.cmd esbuild test/agent-client.ts --bundle --format=esm --platform=node --outfile=.wrangler/agent.mjs
```

실행 (가장 싼 $0.005 엔드포인트):

```powershell
$env:EVM_PRIVATE_KEY="0xYOUR_BUYER_KEY"; node .wrangler/agent.mjs https://k-data-x402-production.theblack1022.workers.dev/api/fx/usdkrw
```

정상 동작 시 출력: 결제 요구사항 → 데이터 JSON → 정산 결과 + basescan 트랜잭션 링크.
수취 지갑에 $0.005 USDC가 들어오면 **"에이전트가 접근하면 수익이 발생한다"가 실증됩니다.**

> 이 클라이언트는 잔액 0인 지갑으로 이미 검증했습니다 — 402 파싱, 가격·수취주소 인식까지 정상이고
> 자금만 있으면 결제가 성립합니다. 실패 시 "지갑에 USDC/가스가 없다"는 안내가 출력됩니다.

---

## 7단계: 디스커버리 확인 및 확장

부트스트랩 결제 후:

1. **x402scan** — 온체인 정산을 자동 인덱싱하므로 가장 확실한 노출 경로입니다.
   https://x402scan.com 에서 수취 주소나 서비스 URL로 확인하세요.

2. **CDP Bazaar 등록 확인**

   ```powershell
   Invoke-RestMethod -Uri "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources" | ConvertTo-Json -Depth 5 | Select-String "k-data"
   ```

   > 주의: CDP Bazaar 인덱싱에는 [미해결 이슈](https://github.com/x402-foundation/x402/issues/2112)가 있습니다
   > (정산 8건에도 등록 안 된 사례 보고). 등록이 안 되더라도 서비스 자체 문제는 아니며,
   > x402scan 쪽 노출이 더 신뢰할 만합니다.

3. **에이전트 크롤러 대응** — 배포된 `/llms.txt`와 `/api/catalog`가 이미 이 역할을 합니다.

4. **커뮤니티 등록** (선택) — [awesome-x402](https://github.com/xpaysh/awesome-x402) 목록에 PR,
   x402 Discord/커뮤니티에 공유. 외부 공개 행위이므로 원하시면 초안을 준비하겠습니다.

---

## 운영 메모

- **가격 조정**: `src/catalog.ts`의 `price_usd`만 고치면 페이월·카탈로그·랜딩·llms.txt에 동시 반영됩니다.
- **엔드포인트 추가**: `src/catalog.ts`의 `ENDPOINTS`에 항목을 추가하고 `src/index.ts`에 핸들러를 하나 붙이면 됩니다.
- **원화 현금화**: 수취한 USDC는 본인 명의 국내 거래소를 통해야 합니다(규제상 사용자 영역).
- **업스트림 rate limit**: 인메모리 TTL 캐시(시세 10초, 마켓 30초, 뉴스 5분, 환율 10분)로 완화돼 있습니다.
