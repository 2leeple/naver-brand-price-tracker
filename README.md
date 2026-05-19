# Naver Brand Price Tracker

Cowlr admin product data에서 네이버 상품만 골라 실제 네이버 스마트스토어/브랜드스토어 페이지의 가격과 품절 상태를 비교하는 Node.js 스크립트입니다.

관리자 페이지 HTML을 긁는 방식이 아니라 관리자 API에서 기준 데이터를 가져오고, Playwright 브라우저로 실제 상품 페이지에 접속해 `livePrice`와 `liveSoldOut`을 읽습니다.

## Features

- 전체 관리자 상품 목록 스캔
- 네이버 상품 자동 분류
- BrandConnect 제휴 링크를 실제 스마트스토어 URL로 변환
- 실제 상품 페이지의 가격 비교
- 실제 상품 페이지의 품절 여부 비교
- 로그인 세션 재사용
- JSON, CSV, Excel-friendly CSV 리포트 생성

## Requirements

- Node.js 18 이상
- npm
- Playwright Chromium
- 네이버 계정 로그인 세션

## Install

```bash
npm install
npx playwright install chromium
```

## Login

네이버가 자동화 브라우저 접근을 로그인 페이지나 보안 확인으로 돌릴 수 있습니다. 처음 한 번은 브라우저를 띄워 직접 로그인해 주세요.

```bash
npm run login
```

브라우저에서 로그인을 마친 뒤 터미널에서 `Enter`를 누르면 세션이 `.playwright-profile`에 저장됩니다.

비밀번호나 쿠키를 코드에 넣지 않습니다. `.playwright-profile`은 로컬 전용이며 Git에는 올리지 않습니다.

## Run

전체 상품을 스캔하고 네이버 상품만 검사합니다.

```bash
npm run track
```

일부만 테스트할 때는 옵션을 붙입니다.

```bash
npm run track -- --limit 5
npm run track -- --id 1069
npm run track -- --delay-ms 3000
```

이미 로그인 세션이 있고 보안 확인이 뜨지 않는 환경에서만 headless 실행을 권장합니다.

```bash
npm run track -- --headless --no-prompt
```

## Output

실행 후 아래 파일이 생성됩니다.

- `marketplace-scan-report.json`: 전체 상품 스캔 결과
- `naver-price-report.json`: 상세 가격/품절 비교 결과
- `naver-price-report.csv`: 일반 CSV 결과
- `naver-price-report-excel.csv`: Excel에서 긴 숫자와 한글을 더 안정적으로 보기 위한 CSV

## Result Fields

| Field | Description |
| --- | --- |
| `adminPrice` | 관리자 API에 저장된 기준 가격 |
| `livePrice` | 실제 네이버 상품 페이지에서 읽은 가격 |
| `priceDiff` | `livePrice - adminPrice` |
| `priceStatus` | `same`, `changed`, `unknown` |
| `adminSoldOut` | 관리자 API에 저장된 품절 상태 |
| `liveSoldOut` | 실제 네이버 상품 페이지에서 읽은 품절 상태 |
| `soldOutStatus` | `same`, `changed`, `unknown` |
| `status` | 가격 또는 품절 중 변경이 있으면 `changed` |
| `finalUrl` | 실제 접속 후 최종 도착한 상품 URL |

## How Price Detection Works

`track-naver-prices.js`는 실제 상품 페이지에서 여러 가격 후보를 수집합니다.

| Source | Example | Weight |
| --- | --- | --- |
| meta tag | `product:price:amount` | 4 |
| JSON / JSON-LD | `ldjson.offers.price`, `script:price` | 3 |
| DOM selector | `class*="price"`, `aria-label*="가격"` | 2 |
| visible text | `19,900원` 같은 화면 텍스트 | 1 |

후보를 모은 뒤 관리자 가격과 가장 가까운 값을 우선으로 고르고, 차이가 같으면 source weight가 높은 값을 선택합니다.

## Known Issues

- 네이버 할인가와 정상가가 동시에 있을 때 가격을 간헐적으로 잘 불러오지 못함

## Notes

- `node_modules`, `.playwright-profile`, 검사 결과 JSON/CSV, 디버그 캡처 파일은 Git에 올리지 않습니다.
- 네이버 보안 확인이 뜨면 열린 브라우저에서 직접 처리한 뒤 터미널에서 `Enter`를 누르면 이어서 진행합니다.
- 가격 후보 중 `JSON-LD offers.price`가 잡히는 경우가 가장 안정적입니다.

## Scripts

```bash
npm run login
npm run track
npm run probe
```
