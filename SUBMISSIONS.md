# 레지스트리·디렉토리 등록 초안

에이전트 유입 경로별 제출 내용입니다. **계정 로그인이 필요한 곳은 직접 제출하셔야 합니다** — 아래는 그대로 붙여넣을 수 있게 준비한 원고입니다.

제출 전에 해야 할 것 (모두 완료):
1. GitHub 공개 레포 [juh5ng/k-data-mcp](https://github.com/juh5ng/k-data-mcp) — 배포되는 패키지의 소스는 **그 레포**이지 이 저장소의 `packages/k-data-mcp/`가 아닙니다. 이쪽은 읽기 전용 미러라 `private: true`로 막아두었습니다.
2. `npm publish` — 그 레포를 clone해 `npm install && npm run build` 후 배포. 빌드를 건너뛰면 `dist/`가 빠진 채 올라가 `npx k-data-mcp`가 즉시 깨집니다. (현재 npm: 0.2.0)
3. [server.json](packages/k-data-mcp/server.json)의 `REPLACE_WITH_YOUR_GITHUB_USERNAME` 두 곳 교체 (완료: juh5ng)

---

## 1. 공식 MCP Registry — 최우선

다른 디렉토리와 클라이언트가 여기를 피드로 읽으므로 **가장 먼저** 등록합니다.

The publisher is a Go binary from the registry's GitHub releases — **not** an npm
package. `@modelcontextprotocol/publisher` does not exist, and the unrelated
`mcp-publisher` package on npm is a third-party browser-automation tool: do not
run it.

Download it into the package checkout (Windows PowerShell):

```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }; Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"; tar xf mcp-publisher.tar.gz mcp-publisher.exe; rm mcp-publisher.tar.gz
```

On macOS or Linux, `brew install mcp-publisher` does the same.

It reads `server.json` from the working directory, so run these from the package
checkout rather than passing a path:

```powershell
.\mcp-publisher.exe validate
```

```powershell
.\mcp-publisher.exe login github
```

```powershell
.\mcp-publisher.exe publish
```

네임스페이스(`io.github.juh5ng/k-data-mcp`)는 GitHub 계정 소유 증명으로 확보됩니다.

---

## 2. mcp.so — GitHub 이슈로 제출

https://github.com/chatmcp/mcp-directory/issues 에 새 이슈:

**제목**
```
Submit: k-data — Korean market data (kimchi premium, news translation) with x402 pay-per-call
```

**본문**
```
Name: k-data
npm: https://www.npmjs.com/package/k-data-mcp
Repo: https://github.com/juh5ng/k-data-mcp
Transport: stdio

Korean market data for AI agents, metered per call in USDC over the x402 protocol —
no account, no API key, no signup.

What makes it different:
- Kimchi premium on a *tradeable* basis. The widely quoted figure uses the official
  USD/KRW rate, but Korean capital controls push the KRW exit leg through USDT, so
  that number isn't actionable. This returns both bases, and they routinely disagree
  in sign — official can read -0.27% while the realizable basis is +0.19%.
- Premium history and percentile context from a continuously recorded archive.
  Answers "is this premium unusual right now?" with percentile, mean, stdev and
  z-score over 1h-90d. No free source publishes this.
- Korean headlines translated to English. Korean myriad units are expanded
  deterministically before translation, so "989억달러" returns as $98.9 billion
  rather than the 10x-off answer language models give unaided.

Free `list_endpoints` tool shows all prices before spending anything.
Spending is capped by K_DATA_MAX_SPEND_USD.
```

---

## 3. Glama — 자동 인덱싱 + 소유권 주장

Glama는 GitHub의 오픈소스 MCP 서버를 자동으로 수집합니다. **공개 레포를 올리는 것만으로 등록**되며, https://glama.ai/mcp/servers 에서 GitHub 로그인 후 소유권을 주장하면 설명·아이콘을 편집할 수 있습니다.

레포에 아래가 있으면 인덱싱 품질이 올라갑니다 (이미 준비됨):
- `README.md` — 설치 스니펫과 도구 표
- `package.json`의 `keywords`
- MIT 라이선스

---

## 4. Smithery

https://smithery.ai 에서 GitHub 로그인 → **Add Server** → 레포 URL 입력.

**한 줄 설명**
```
Korean market data for agents — tradeable-basis kimchi premium, premium history and percentiles, Korean news translated to English. Pay-per-call in USDC via x402, no API key.
```

---

## 5. PulseMCP

https://www.pulsemcp.com/submit 폼:

| 항목 | 값 |
|---|---|
| Name | k-data |
| Description | Korean market data for agents: tradeable-basis kimchi premium, premium history and percentiles, Korean news translated to English. Metered per call in USDC via x402 — no account or API key. |
| Repository | `https://github.com/juh5ng/k-data-mcp` |
| npm | `k-data-mcp` |
| Transport | stdio |
| Categories | finance, crypto, news, data |

---

## 6. awesome-x402 — PR

https://github.com/xpaysh/awesome-x402 를 fork → README의 서비스 목록에 한 줄 추가 → PR.

**추가할 줄**
```markdown
- [K-Data](https://k-data-x402-production.theblack1022.workers.dev) — Korean market data: kimchi premium on a tradeable USDT basis (not just the untradeable official-FX figure), premium history and percentile context from a continuous archive, and Korean news translated to English. 9 endpoints, $0.005–$0.12. [MCP server](https://www.npmjs.com/package/k-data-mcp) included.
```

**PR 제목**
```
Add K-Data — Korean market data API (kimchi premium, news translation)
```

**PR 본문**
```
Adds K-Data, an x402-metered API serving Korean market data to agents.

Live: https://k-data-x402-production.theblack1022.workers.dev
Catalog: /api/catalog · OpenAPI: /openapi.json · llms.txt: /llms.txt
Settlement verified on Base mainnet via the CDP facilitator.

Differentiator worth noting for the list: it reports the kimchi premium on both the
official USD/KRW basis (the quoted figure) and the Upbit KRW/USDT basis (the margin
actually realizable given Korean capital controls). The two frequently disagree in
sign, so agents acting on the official number alone reach the opposite conclusion.

An MCP server (`k-data-mcp`) is published alongside it, with a free `list_endpoints`
tool and a hard spend cap.
```

---

## 7. awesome-mcp-servers — PR

https://github.com/punkpeye/awesome-mcp-servers — Finance 섹션에 추가:

```markdown
- [k-data-mcp](https://github.com/juh5ng/k-data-mcp) 🏎️ ☁️ - Korean market data: tradeable-basis kimchi premium, premium history and percentiles, Korean news translated to English. Pay-per-call in USDC via x402, no API key.
```

---

## 등록 후 확인

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=k-data"
```

x402 Bazaar 쪽은 별도로 정산이 쌓여야 인덱싱됩니다:

```powershell
Invoke-RestMethod -Uri "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources" | ConvertTo-Json -Depth 5 | Select-String "k-data"
```
