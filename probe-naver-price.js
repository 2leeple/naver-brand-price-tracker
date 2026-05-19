const fs = require("fs/promises");
const { chromium } = require("playwright");

const TARGET_URL =
  "https://smartstore.naver.com/main/products/6049873307";

async function main() {
  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 1600 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  const title = await page.title();
  const finalUrl = page.url();
  const bodyText = await page.locator("body").innerText();
  const priceLines = bodyText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\d[\d,]*\s*원/.test(line))
    .slice(0, 30);

  await page.screenshot({ path: "probe-naver-price.png", fullPage: true });
  await fs.writeFile("probe-naver-price.html", await page.content(), "utf8");

  console.log(
    JSON.stringify(
      {
        title,
        finalUrl,
        priceLines,
      },
      null,
      2,
    ),
  );

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
