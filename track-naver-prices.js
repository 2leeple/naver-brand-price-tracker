const fs = require("fs/promises");
const path = require("path");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const { chromium } = require("playwright");

const ADMIN_API_URL =
  "https://turbocowlr-backend-ifh2svcytq-uc.a.run.app/admin/protein";
const BRANDCONNECT_REDIRECT_API =
  "https://gw-brandconnect.naver.com/affiliate/query/affiliate-urls";
const NAVER_LOGIN_URL =
  "https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fsmartstore.naver.com%2F";

const argv = process.argv.slice(2);
const options = {
  limit: readNumberFlag("--limit"),
  id: readNumberFlag("--id"),
  headless: argv.includes("--headless"),
  login: argv.includes("--login"),
  noPrompt: argv.includes("--no-prompt"),
  delayMs: readNumberFlag("--delay-ms") ?? 2500,
};

function readNumberFlag(flagName) {
  const index = argv.indexOf(flagName);
  if (index === -1 || index === argv.length - 1) {
    return null;
  }

  const parsed = Number(argv[index + 1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function profileDirPath() {
  return path.join(__dirname, ".playwright-profile");
}

async function writeUtf8BomFile(filePath, text) {
  await fs.writeFile(filePath, `\uFEFF${text}`, "utf8");
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchText(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function parseUrl(value) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hostMatches(url, hosts) {
  return Boolean(url && hosts.includes(url.hostname));
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 0 || value === 1) {
      return Boolean(value);
    }
    return null;
  }

  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();

    if (["true", "1", "yes", "y"].includes(lowered)) {
      return true;
    }

    if (["false", "0", "no", "n"].includes(lowered)) {
      return false;
    }
  }

  return null;
}

function numberFromUnknown(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.]/g, "");
    if (!cleaned) {
      return null;
    }

    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }

  return null;
}

function parseChannelProductNo(product) {
  const candidates = [product.source_url, product.coupang_link].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      const channelProductNo = url.searchParams.get("channelProductNo");
      if (channelProductNo) {
        return channelProductNo;
      }

      const productMatch = url.pathname.match(/\/products\/(\d+)/);
      if (productMatch) {
        return productMatch[1];
      }
    } catch {
      continue;
    }
  }

  return null;
}

function classifyMarketplace(product) {
  const coupangLinkUrl = parseUrl(product.coupang_link);
  const sourceUrl = parseUrl(product.source_url);
  const hosts = [coupangLinkUrl?.hostname, sourceUrl?.hostname].filter(Boolean);
  const channelProductNo = parseChannelProductNo(product);

  const naverHosts = [
    "naver.me",
    "brandconnect.naver.com",
    "gw-brandconnect.naver.com",
    "smartstore.naver.com",
    "m.smartstore.naver.com",
  ];
  const coupangHosts = [
    "link.coupang.com",
    "www.coupang.com",
    "m.coupang.com",
    "coupa.ng",
  ];

  if (hostMatches(coupangLinkUrl, naverHosts) || hostMatches(sourceUrl, naverHosts)) {
    return {
      marketplace: "naver",
      matchedBy: "link-host",
      channelProductNo,
      hosts,
    };
  }

  if (
    product.coupang_link?.includes("smartstore.naver.com") ||
    product.source_url?.includes("smartstore.naver.com")
  ) {
    return {
      marketplace: "naver",
      matchedBy: "smartstore-url",
      channelProductNo,
      hosts,
    };
  }

  if (hostMatches(coupangLinkUrl, coupangHosts) || hostMatches(sourceUrl, coupangHosts)) {
    return {
      marketplace: "coupang",
      matchedBy: "link-host",
      channelProductNo,
      hosts,
    };
  }

  if (product.source === "naver" && channelProductNo) {
    return {
      marketplace: "naver",
      matchedBy: "source-field-fallback",
      channelProductNo,
      hosts,
    };
  }

  if (product.source === "fallcent") {
    return {
      marketplace: "coupang",
      matchedBy: "source-field-fallback",
      channelProductNo,
      hosts,
    };
  }

  return {
    marketplace: "unknown",
    matchedBy: "unclassified",
    channelProductNo,
    hosts,
  };
}

function scanProducts(allProducts) {
  const scanned = allProducts.map((product) => ({
    ...product,
    ...classifyMarketplace(product),
  }));

  const summary = scanned.reduce(
    (acc, product) => {
      acc.total += 1;
      acc.byMarketplace[product.marketplace] =
        (acc.byMarketplace[product.marketplace] ?? 0) + 1;
      acc.byMatchedBy[product.matchedBy] = (acc.byMatchedBy[product.matchedBy] ?? 0) + 1;
      return acc;
    },
    {
      total: 0,
      byMarketplace: {},
      byMatchedBy: {},
    },
  );

  return { scanned, summary };
}

async function resolveRedirectUrl(product) {
  const channelProductNo = parseChannelProductNo(product);
  if (!channelProductNo) {
    return {
      channelProductNo: null,
      smartstoreUrl: product.coupang_link ?? null,
      bridgeUrl: null,
    };
  }

  const affiliateMatch = product.source_url?.match(/affiliates\/(\d+)/);
  const affiliateUrlId = affiliateMatch?.[1];

  if (!affiliateUrlId) {
    return {
      channelProductNo,
      smartstoreUrl: `https://smartstore.naver.com/main/products/${channelProductNo}`,
      bridgeUrl: null,
    };
  }

  const bridgeUrl = `${BRANDCONNECT_REDIRECT_API}/${affiliateUrlId}/redirect-url?channelProductNo=${encodeURIComponent(channelProductNo)}`;
  const redirectText = await fetchText(bridgeUrl, {
    headers: {
      "X-REFERER-URL": product.source_url ?? product.coupang_link ?? "",
    },
  });

  const smartstoreUrl =
    redirectText.match(/https:\/\/smartstore\.naver\.com\/[^\s"]+/)?.[0] ??
    `https://smartstore.naver.com/main/products/${channelProductNo}`;

  return {
    channelProductNo,
    smartstoreUrl,
    bridgeUrl: redirectText.trim(),
  };
}

async function waitForHuman(page) {
  if (options.noPrompt) {
    return false;
  }

  console.log("");
  console.log("보안 확인 페이지가 열렸습니다.");
  console.log("브라우저에서 검증을 마친 뒤 Enter를 눌러 주세요.");

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    await rl.question("> ");
  } finally {
    rl.close();
  }

  await page.waitForTimeout(1500);
  return true;
}

function isLoginPage(pageUrl, text) {
  const url = String(pageUrl || "").toLowerCase();
  const body = String(text || "").toLowerCase();

  if (url.includes("nid.naver.com/nidlogin.login")) {
    return true;
  }

  const hasLoginForm =
    body.includes("아이디 또는 전화번호") &&
    body.includes("비밀번호") &&
    (body.includes("로그인 상태 유지") ||
      body.includes("일회용 번호") ||
      body.includes("qr코드"));

  return body.includes("네이버 : 로그인") || hasLoginForm;
}

async function waitForLogin(page) {
  if (options.noPrompt) {
    return false;
  }

  console.log("");
  console.log("네이버 로그인이 필요합니다.");
  console.log("열린 브라우저에서 직접 로그인한 뒤 Enter를 눌러 주세요.");

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    await rl.question("> ");
  } finally {
    rl.close();
  }

  await page
    .waitForURL((url) => !url.href.includes("nid.naver.com/nidlogin.login"), {
      timeout: 10000,
    })
    .catch(() => null);
  await page.waitForTimeout(1500);
  return true;
}

async function runLoginMode(page) {
  await page.goto(NAVER_LOGIN_URL, {
    waitUntil: "domcontentloaded",
  });

  const continued = await waitForLogin(page);
  const pageText = await page.locator("body").innerText().catch(() => "");

  return {
    mode: "login",
    continued,
    loggedIn: !isLoginPage(page.url(), pageText),
    finalUrl: page.url(),
    profileDir: profileDirPath(),
  };
}

async function extractProductState(page, adminPrice) {
  return page.evaluate(({ adminPriceValue }) => {
    const candidates = [];
    const availabilitySignals = [];
    const priceLineRegex = /(\d[\d,]{2,})\s*원?/;
    const soldOutKeywords = [
      "품절",
      "일시품절",
      "판매종료",
      "판매 종료",
      "구매불가",
      "재입고 알림",
      "재입고알림",
      "sold out",
      "out of stock",
    ];
    const availableKeywords = [
      "구매하기",
      "판매중",
      "장바구니",
      "바로구매",
      "구매 가능",
      "주문하기",
      "주문 가능",
      "instock",
      "in stock",
      "on sale",
      "available",
    ];

    const pushCandidate = (price, source, label) => {
      if (!Number.isFinite(price) || price < 100) {
        return;
      }

      candidates.push({
        price: Math.round(price),
        source,
        label,
      });
    };

    const addAvailabilitySignal = (soldOut, source, label) => {
      if (typeof soldOut !== "boolean") {
        return;
      }

      availabilitySignals.push({
        soldOut,
        source,
        label,
      });
    };

    const localNumberFromUnknown = (value) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.round(value);
      }

      if (typeof value === "string") {
        const cleaned = value.replace(/[^\d.]/g, "");
        if (!cleaned) {
          return null;
        }

        const parsed = Number(cleaned);
        return Number.isFinite(parsed) ? Math.round(parsed) : null;
      }

      return null;
    };

    const isSoldOutKeyword = (value) => {
      const lowered = String(value || "").toLowerCase();
      return soldOutKeywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
    };

    const isAvailableKeyword = (value) => {
      const lowered = String(value || "").toLowerCase();
      return availableKeywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
    };

    const collectPriceFields = (value, pathLabel) => {
      if (!value || typeof value !== "object") {
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((item, index) => collectPriceFields(item, `${pathLabel}[${index}]`));
        return;
      }

      for (const [key, child] of Object.entries(value)) {
        const nextPath = `${pathLabel}.${key}`;
        const looksLikePriceKey =
          /(^|_)(price|salePrice|discountPrice|discountedPrice|immediateDiscountPrice|benefitPrice|sellingPrice)/i.test(
            key,
          );

        if (looksLikePriceKey) {
          const price = localNumberFromUnknown(child);
          if (price) {
            pushCandidate(price, "json", nextPath);
          }
        }

        if (typeof child === "object") {
          collectPriceFields(child, nextPath);
        }
      }
    };

    const collectAvailabilityFields = (value, pathLabel) => {
      if (!value || typeof value !== "object") {
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((item, index) =>
          collectAvailabilityFields(item, `${pathLabel}[${index}]`),
        );
        return;
      }

      for (const [key, child] of Object.entries(value)) {
        const nextPath = `${pathLabel}.${key}`;
        const loweredKey = key.toLowerCase();

        if (
          [
            "soldout",
            "issoldout",
            "sold_out",
            "stockquantity",
            "quantity",
            "salestatus",
            "productstatus",
            "availability",
            "buyable",
            "purchasable",
          ].includes(loweredKey)
        ) {
          if (typeof child === "boolean") {
            addAvailabilitySignal(
              loweredKey.includes("buyable") || loweredKey.includes("purchasable")
                ? !child
                : child,
              "json",
              nextPath,
            );
          } else if (
            typeof child === "number" &&
            (loweredKey.includes("stockquantity") || loweredKey === "quantity")
          ) {
            addAvailabilitySignal(child <= 0, "json", `${nextPath}:${child}`);
          } else if (typeof child === "string") {
            if (
              child.includes("http://schema.org/OutOfStock") ||
              child.includes("https://schema.org/OutOfStock")
            ) {
              addAvailabilitySignal(true, "json", `${nextPath}:${child}`);
            } else if (
              child.includes("http://schema.org/InStock") ||
              child.includes("https://schema.org/InStock")
            ) {
              addAvailabilitySignal(false, "json", `${nextPath}:${child}`);
            } else if (isSoldOutKeyword(child)) {
              addAvailabilitySignal(true, "json", `${nextPath}:${child}`);
            } else if (isAvailableKeyword(child)) {
              addAvailabilitySignal(false, "json", `${nextPath}:${child}`);
            }
          }
        }

        if (typeof child === "object") {
          collectAvailabilityFields(child, nextPath);
        }
      }
    };

    const metaSelectors = [
      'meta[property="product:price:amount"]',
      'meta[itemprop="price"]',
      'meta[name="price"]',
      'meta[property="og:price:amount"]',
    ];

    for (const selector of metaSelectors) {
      const element = document.querySelector(selector);
      const price = localNumberFromUnknown(element?.getAttribute("content"));
      if (price) {
        pushCandidate(price, "meta", selector);
      }
    }

    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || "");
        collectPriceFields(parsed, "ldjson");
        collectAvailabilityFields(parsed, "ldjson");
      } catch {
        continue;
      }
    }

    for (const script of document.querySelectorAll("script")) {
      const text = script.textContent || "";
      if (!text || text.length < 100) {
        continue;
      }

      const priceMatches = [
        ...text.matchAll(
          /"(salePrice|discountPrice|discountedPrice|immediateDiscountPrice|sellingPrice|price)"\s*:\s*"?([\d,]+(?:\.\d+)?)"?/gi,
        ),
      ];

      for (const match of priceMatches) {
        const price = localNumberFromUnknown(match[2]);
        if (price) {
          pushCandidate(price, "json", `script:${match[1]}`);
        }
      }

      const availabilityPatterns = [
        { regex: /"(soldOut|isSoldOut|sold_out)"\s*:\s*(true|false)/gi, invert: false },
        { regex: /"(buyable|purchasable)"\s*:\s*(true|false)/gi, invert: true },
        { regex: /"(stockQuantity|quantity)"\s*:\s*(\d+)/gi, numericStock: true },
        { regex: /"(availability|saleStatus|productStatus)"\s*:\s*"([^"]+)"/gi },
      ];

      for (const pattern of availabilityPatterns) {
        for (const match of text.matchAll(pattern.regex)) {
          if (pattern.numericStock) {
            addAvailabilitySignal(
              Number(match[2]) <= 0,
              "json",
              `script:${match[1]}:${match[2]}`,
            );
            continue;
          }

          const rawValue = String(match[2]);
          const loweredValue = rawValue.toLowerCase();

          if (loweredValue === "true" || loweredValue === "false") {
            addAvailabilitySignal(
              pattern.invert ? loweredValue !== "true" : loweredValue === "true",
              "json",
              `script:${match[1]}:${rawValue}`,
            );
            continue;
          }

          if (
            loweredValue.includes("outofstock") ||
            loweredValue.includes("soldout") ||
            loweredValue.includes("sold_out") ||
            loweredValue.includes("sold out") ||
            rawValue.includes("http://schema.org/OutOfStock") ||
            rawValue.includes("https://schema.org/OutOfStock") ||
            isSoldOutKeyword(rawValue)
          ) {
            addAvailabilitySignal(true, "json", `script:${match[1]}:${rawValue}`);
          } else if (
            loweredValue.includes("instock") ||
            loweredValue.includes("on_sale") ||
            loweredValue.includes("onsale") ||
            rawValue.includes("http://schema.org/InStock") ||
            rawValue.includes("https://schema.org/InStock") ||
            isAvailableKeyword(rawValue)
          ) {
            addAvailabilitySignal(false, "json", `script:${match[1]}:${rawValue}`);
          }
        }
      }
    }

    const selectorCandidates = [
      '[class*="price"]',
      '[class*="Price"]',
      '[data-testid*="price"]',
      '[aria-label*="가격"]',
      '[aria-label*="판매가"]',
    ];

    for (const selector of selectorCandidates) {
      for (const element of document.querySelectorAll(selector)) {
        const text = (element.textContent || "").trim();
        const match = text.match(priceLineRegex);
        if (match) {
          const price = localNumberFromUnknown(match[1]);
          if (price) {
            pushCandidate(price, "selector", selector);
          }
        }
      }
    }

    const bodyText = document.body?.innerText || "";
    const visibleLines = bodyText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => priceLineRegex.test(line))
      .slice(0, 300);

    for (const line of visibleLines) {
      const match = line.match(priceLineRegex);
      if (match) {
        const price = localNumberFromUnknown(match[1]);
        if (price) {
          pushCandidate(price, "text", line);
        }
      }
    }

    const buttonText = Array.from(
      document.querySelectorAll("button, [role='button'], a"),
    )
      .map((element) => (element.textContent || "").trim())
      .filter(Boolean)
      .slice(0, 200)
      .join("\n");

    for (const keyword of soldOutKeywords) {
      if (bodyText.includes(keyword) || buttonText.includes(keyword)) {
        addAvailabilitySignal(true, "text", keyword);
      }
    }

    for (const keyword of availableKeywords) {
      if (bodyText.includes(keyword) || buttonText.includes(keyword)) {
        addAvailabilitySignal(false, "text", keyword);
      }
    }

    const uniqueCandidates = [];
    const seenCandidates = new Set();
    for (const candidate of candidates) {
      const key = `${candidate.source}:${candidate.label}:${candidate.price}`;
      if (seenCandidates.has(key)) {
        continue;
      }
      seenCandidates.add(key);
      uniqueCandidates.push(candidate);
    }

    const rankedCandidates = uniqueCandidates
      .map((candidate) => {
        const diff =
          typeof adminPriceValue === "number"
            ? Math.abs(candidate.price - adminPriceValue)
            : Number.MAX_SAFE_INTEGER;
        const sourceWeight =
          candidate.source === "meta"
            ? 4
            : candidate.source === "json"
              ? 3
              : candidate.source === "selector"
                ? 2
                : 1;

        return {
          ...candidate,
          diff,
          sourceWeight,
        };
      })
      .sort((a, b) => {
        if (a.diff !== b.diff) {
          return a.diff - b.diff;
        }
        if (a.sourceWeight !== b.sourceWeight) {
          return b.sourceWeight - a.sourceWeight;
        }
        return a.price - b.price;
      });

    const uniqueAvailabilitySignals = [];
    const seenAvailabilitySignals = new Set();
    for (const signal of availabilitySignals) {
      const key = `${signal.source}:${signal.label}:${signal.soldOut}`;
      if (seenAvailabilitySignals.has(key)) {
        continue;
      }
      seenAvailabilitySignals.add(key);
      uniqueAvailabilitySignals.push(signal);
    }

    const rankedAvailabilitySignals = uniqueAvailabilitySignals
      .map((signal) => ({
        ...signal,
        sourceWeight: signal.source === "json" ? 3 : signal.source === "selector" ? 2 : 1,
      }))
      .sort((a, b) => b.sourceWeight - a.sourceWeight);

    const soldOutTrueSignals = rankedAvailabilitySignals.filter((signal) => signal.soldOut);
    const soldOutFalseSignals = rankedAvailabilitySignals.filter((signal) => !signal.soldOut);

    let soldOut = null;
    if (soldOutTrueSignals.length || soldOutFalseSignals.length) {
      soldOut = soldOutTrueSignals.length > soldOutFalseSignals.length;

      if (soldOutTrueSignals.length && !soldOutFalseSignals.length) {
        soldOut = true;
      }

      if (!soldOutTrueSignals.length && soldOutFalseSignals.length) {
        soldOut = false;
      }

      if (
        soldOutTrueSignals.length &&
        soldOutFalseSignals.length &&
        soldOutTrueSignals[0].sourceWeight !== soldOutFalseSignals[0].sourceWeight
      ) {
        soldOut = soldOutTrueSignals[0].sourceWeight > soldOutFalseSignals[0].sourceWeight;
      }
    }

    return {
      title: document.title,
      visibleLines: visibleLines.slice(0, 20),
      candidates: rankedCandidates.slice(0, 20),
      best: rankedCandidates[0] ?? null,
      soldOut,
      availabilitySignals: rankedAvailabilitySignals.slice(0, 20),
      buttonTextPreview: buttonText
        .split("\n")
        .filter(Boolean)
        .slice(0, 20),
    };
  }, { adminPriceValue: adminPrice });
}

function isCaptchaPage(text) {
  const body = String(text || "").toLowerCase();

  return (
    body.includes("보안 확인") ||
    body.includes("실제 사용자임을 확인") ||
    body.includes("자동화된 접근") ||
    body.includes("captcha") ||
    body.includes("robot")
  );
}

function comparePriceState(adminPrice, livePrice) {
  if (typeof adminPrice !== "number" || typeof livePrice !== "number") {
    return "unknown";
  }

  return adminPrice === livePrice ? "same" : "changed";
}

function compareSoldOutState(adminSoldOut, liveSoldOut) {
  const adminValue = normalizeBoolean(adminSoldOut);
  const liveValue = normalizeBoolean(liveSoldOut);

  if (adminValue === null || liveValue === null) {
    return "unknown";
  }

  return adminValue === liveValue ? "same" : "changed";
}

function summarizeRowStatus(priceStatus, soldOutStatus, livePrice, liveSoldOut) {
  if (priceStatus === "changed" || soldOutStatus === "changed") {
    return "changed";
  }

  if (priceStatus === "same" || soldOutStatus === "same") {
    return "same";
  }

  if (typeof livePrice === "number" || typeof liveSoldOut === "boolean") {
    return "observed";
  }

  return "unresolved";
}

async function loadPageText(page, url) {
  if (url) {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
    });
  }

  await page.waitForTimeout(2500);
  return page.locator("body").innerText().catch(() => "");
}

async function visitProduct(page, product, redirectInfo) {
  let pageText = await loadPageText(page, redirectInfo.smartstoreUrl);

  if (isLoginPage(page.url(), pageText)) {
    const continued = await waitForLogin(page);
    if (!continued) {
      return {
        status: "login_required",
        priceStatus: "unknown",
        soldOutStatus: "unknown",
        livePrice: null,
        liveSoldOut: null,
        finalUrl: page.url(),
        details: {
          reason: "login_required",
        },
      };
    }

    pageText = await loadPageText(page, redirectInfo.smartstoreUrl);
    if (isLoginPage(page.url(), pageText)) {
      return {
        status: "login_required",
        priceStatus: "unknown",
        soldOutStatus: "unknown",
        livePrice: null,
        liveSoldOut: null,
        finalUrl: page.url(),
        details: {
          reason: "login_required",
        },
      };
    }
  }

  if (isCaptchaPage(pageText)) {
    const continued = await waitForHuman(page);
    if (!continued) {
      return {
        status: "captcha",
        priceStatus: "unknown",
        soldOutStatus: "unknown",
        livePrice: null,
        liveSoldOut: null,
        finalUrl: page.url(),
        details: {
          reason: "captcha",
        },
      };
    }

    await page.waitForLoadState("domcontentloaded").catch(() => null);
    pageText = await page.locator("body").innerText().catch(() => "");

    if (isCaptchaPage(pageText)) {
      pageText = await loadPageText(page, redirectInfo.smartstoreUrl);
    }
  }

  if (isLoginPage(page.url(), pageText)) {
    return {
      status: "login_required",
      priceStatus: "unknown",
      soldOutStatus: "unknown",
      livePrice: null,
      liveSoldOut: null,
      finalUrl: page.url(),
      details: {
        reason: "login_required",
      },
    };
  }

  if (isCaptchaPage(pageText)) {
    return {
      status: "captcha",
      priceStatus: "unknown",
      soldOutStatus: "unknown",
      livePrice: null,
      liveSoldOut: null,
      finalUrl: page.url(),
      details: {
        reason: "captcha",
      },
    };
  }

  const details = await extractProductState(page, product.price);
  const livePrice = details.best?.price ?? null;
  const liveSoldOut =
    typeof details.soldOut === "boolean"
      ? details.soldOut
      : null;
  const priceStatus = comparePriceState(product.price, livePrice);
  const soldOutStatus = compareSoldOutState(product.sold_out, liveSoldOut);
  const status = summarizeRowStatus(priceStatus, soldOutStatus, livePrice, liveSoldOut);

  return {
    status,
    priceStatus,
    soldOutStatus,
    livePrice,
    liveSoldOut,
    finalUrl: page.url(),
    details,
  };
}

function toCsv(rows, options = {}) {
  const { excelFriendly = false } = options;
  const headers = [
    "id",
    "name",
    "adminPrice",
    "livePrice",
    "priceDiff",
    "priceStatus",
    "adminSoldOut",
    "liveSoldOut",
    "soldOutStatus",
    "status",
    "marketplace",
    "matchedBy",
    "source",
    "channelProductNo",
    "smartstoreUrl",
    "sourceUrl",
    "finalUrl",
  ];

  const escapeCsv = (value) => {
    const text = value == null ? "" : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };

  const excelText = (value) => {
    if (value == null || value === "") {
      return "";
    }

    const text = String(value).replace(/"/g, '""');
    return `="${text}"`;
  };

  const serializeValue = (row, key) => {
    const value = row[key];

    if (excelFriendly && (key === "id" || key === "channelProductNo")) {
      return excelText(value);
    }

    return value;
  };

  return [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((key) => serializeValue(row, key))
        .map(escapeCsv)
        .join(","),
    ),
  ].join("\n");
}

async function launchBrowserContext() {
  return chromium.launchPersistentContext(profileDirPath(), {
    headless: options.headless,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 1600 },
  });
}

async function writeScanReport(
  filePath,
  scanSummary,
  detectedNaverProducts,
  selectedProducts,
  scannedProducts,
) {
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        summary: scanSummary,
        detectedNaverProductCount: detectedNaverProducts.length,
        selectedNaverProductCount: selectedProducts.length,
        products: scannedProducts.map((product) => ({
          id: product.id,
          name: product.name,
          price: product.price,
          soldOut: normalizeBoolean(product.sold_out),
          source: product.source,
          marketplace: product.marketplace,
          matchedBy: product.matchedBy,
          channelProductNo: product.channelProductNo,
          coupangLink: product.coupang_link ?? "",
          sourceUrl: product.source_url ?? "",
          hosts: product.hosts,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function main() {
  if (options.login && options.headless) {
    throw new Error("--login mode requires a visible browser. Remove --headless.");
  }

  const context = await launchBrowserContext();
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    if (options.login) {
      const loginSummary = await runLoginMode(page);
      console.log("");
      console.log(JSON.stringify(loginSummary, null, 2));
      return;
    }

    const allProducts = await fetchJson(ADMIN_API_URL);
    const { scanned: scannedProducts, summary: scanSummary } = scanProducts(allProducts);
    const detectedNaverProducts = scannedProducts.filter(
      (product) => product.marketplace === "naver",
    );

    let naverProducts = detectedNaverProducts;
    if (options.id) {
      naverProducts = naverProducts.filter((product) => product.id === options.id);
    }

    if (options.limit) {
      naverProducts = naverProducts.slice(0, options.limit);
    }

    if (!naverProducts.length) {
      throw new Error("No Naver products were found after scanning the full product list.");
    }

    const scanReportPath = path.join(__dirname, "marketplace-scan-report.json");
    await writeScanReport(
      scanReportPath,
      scanSummary,
      detectedNaverProducts,
      naverProducts,
      scannedProducts,
    );

    const results = [];

    for (const [index, product] of naverProducts.entries()) {
      console.log("");
      console.log(`[${index + 1}/${naverProducts.length}] ${product.id} ${product.name}`);

      try {
        const redirectInfo = await resolveRedirectUrl(product);
        const visitResult = await visitProduct(page, product, redirectInfo);
        const row = {
          id: product.id,
          name: product.name,
          adminPrice: product.price,
          livePrice: visitResult.livePrice,
          priceDiff:
            typeof visitResult.livePrice === "number"
              ? visitResult.livePrice - product.price
              : null,
          priceStatus: visitResult.priceStatus,
          adminSoldOut: normalizeBoolean(product.sold_out),
          liveSoldOut: normalizeBoolean(visitResult.liveSoldOut),
          soldOutStatus: visitResult.soldOutStatus,
          status: visitResult.status,
          marketplace: product.marketplace,
          matchedBy: product.matchedBy,
          source: product.source,
          channelProductNo: redirectInfo.channelProductNo,
          smartstoreUrl: redirectInfo.smartstoreUrl,
          bridgeUrl: redirectInfo.bridgeUrl,
          sourceUrl: product.source_url ?? "",
          coupangLink: product.coupang_link ?? "",
          finalUrl: visitResult.finalUrl,
          pageTitle: visitResult.details?.title ?? "",
          details: visitResult.details,
        };

        results.push(row);
        console.log(
          JSON.stringify(
            {
              status: row.status,
              adminPrice: row.adminPrice,
              livePrice: row.livePrice,
              priceStatus: row.priceStatus,
              adminSoldOut: row.adminSoldOut,
              liveSoldOut: row.liveSoldOut,
              soldOutStatus: row.soldOutStatus,
              finalUrl: row.finalUrl,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        results.push({
          id: product.id,
          name: product.name,
          adminPrice: product.price,
          livePrice: null,
          priceDiff: null,
          priceStatus: "unknown",
          adminSoldOut: normalizeBoolean(product.sold_out),
          liveSoldOut: null,
          soldOutStatus: "unknown",
          status: "error",
          marketplace: product.marketplace,
          matchedBy: product.matchedBy,
          source: product.source,
          channelProductNo: parseChannelProductNo(product),
          smartstoreUrl: null,
          bridgeUrl: null,
          sourceUrl: product.source_url ?? "",
          coupangLink: product.coupang_link ?? "",
          finalUrl: null,
          pageTitle: "",
          details: {
            message: error.message,
          },
        });

        console.error(error.message);
      }

      await sleep(options.delayMs);
    }

    const reportJsonPath = path.join(__dirname, "naver-price-report.json");
    const reportCsvPath = path.join(__dirname, "naver-price-report.csv");
    const reportExcelCsvPath = path.join(__dirname, "naver-price-report-excel.csv");

    await fs.writeFile(reportJsonPath, JSON.stringify(results, null, 2), "utf8");
    await writeUtf8BomFile(reportCsvPath, toCsv(results));
    await writeUtf8BomFile(
      reportExcelCsvPath,
      toCsv(results, { excelFriendly: true }),
    );

    const summary = {
      total: results.length,
      scan: scanSummary,
      detectedNaverProductCount: detectedNaverProducts.length,
      selectedNaverProductCount: naverProducts.length,
      changed: results.filter((row) => row.status === "changed").length,
      same: results.filter((row) => row.status === "same").length,
      observed: results.filter((row) => row.status === "observed").length,
      unresolved: results.filter((row) => row.status === "unresolved").length,
      loginRequired: results.filter((row) => row.status === "login_required").length,
      captcha: results.filter((row) => row.status === "captcha").length,
      error: results.filter((row) => row.status === "error").length,
      priceChanged: results.filter((row) => row.priceStatus === "changed").length,
      soldOutChanged: results.filter((row) => row.soldOutStatus === "changed").length,
      output: {
        scan: scanReportPath,
        json: reportJsonPath,
        csv: reportCsvPath,
        excelCsv: reportExcelCsvPath,
      },
    };

    console.log("");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
