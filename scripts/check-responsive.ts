import { chromium, type Page } from "playwright";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const baseUrl = (process.env.RESPONSIVE_CHECK_URL || process.env.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const credentials = process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD
  ? Buffer.from(`${process.env.ADMIN_USERNAME}:${process.env.ADMIN_PASSWORD}`).toString("base64")
  : "";

const viewports = [
  { name: "mobile-320", width: 320, height: 760 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "desktop-1440", width: 1440, height: 950 }
];

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const result = await page.evaluate(() => {
    const documentElement = document.documentElement;
    const body = document.body;
    const viewportWidth = documentElement.clientWidth;
    const overflowing = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);

        if (rect.width <= 0 || rect.height <= 0 || style.position === "fixed") {
          return false;
        }

        return rect.left < -1 || rect.right > viewportWidth + 1;
      })
      .slice(0, 10)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: element.className,
        text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) ?? "",
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
        viewportWidth
      }));

    return {
      documentOverflow: documentElement.scrollWidth - documentElement.clientWidth,
      bodyOverflow: body.scrollWidth - body.clientWidth,
      overflowing
    };
  });

  if (result.documentOverflow > 1 || result.bodyOverflow > 1 || result.overflowing.length > 0) {
    throw new Error(`${label} has horizontal overflow: ${JSON.stringify(result)}`);
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });

  try {
    for (const viewport of viewports) {
      const loginPage = await browser.newPage({ viewport });
      await loginPage.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
      await assertNoHorizontalOverflow(loginPage, `login ${viewport.name}`);
      await loginPage.close();

      if (!credentials) {
        continue;
      }

      const adminPage = await browser.newPage({
        viewport,
        extraHTTPHeaders: { Authorization: `Basic ${credentials}` }
      });
      await adminPage.goto(`${baseUrl}/api/admin`, { waitUntil: "networkidle" });
      await assertNoHorizontalOverflow(adminPage, `admin ${viewport.name}`);
      await adminPage.close();
    }
  } finally {
    await browser.close();
  }

  console.log("Responsive checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
