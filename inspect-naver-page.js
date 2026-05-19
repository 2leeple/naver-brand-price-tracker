const path = require("path");
const { chromium } = require("playwright");

const targetUrl =
  process.argv[2] || "https://smartstore.naver.com/main/products/6049873307";

async function main() {
  const profileDir = path.join(__dirname, ".playwright-profile");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 1600 },
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => {
    const scripts = [...document.querySelectorAll("script")]
      .map((script) => script.textContent || "")
      .filter(Boolean);

    const keywordHits = [];
    const keywords = [
      "sold",
      "soldOut",
      "sold_out",
      "품절",
      "재고",
      "stock",
      "purchase",
      "buyable",
      "saleStatus",
      "productStatus",
    ];

    for (const text of scripts) {
      for (const keyword of keywords) {
        if (text.includes(keyword)) {
          keywordHits.push({
            keyword,
            sample: text.slice(
              Math.max(0, text.indexOf(keyword) - 180),
              Math.min(text.length, text.indexOf(keyword) + 480),
            ),
          });
        }
      }
    }

    return {
      title: document.title,
      url: location.href,
      bodyPreview: (document.body?.innerText || "").split("\n").slice(0, 60),
      keywordHits: keywordHits.slice(0, 50),
    };
  });

  console.log(JSON.stringify(result, null, 2));

  await page.waitForTimeout(1000);
  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
