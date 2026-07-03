const express = require("express");
const multer = require("multer");
const { chromium } = require("playwright");

const app = express();
const upload = multer({ dest: "/tmp/uploads" });

app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

function normalizeCookies(rawCookies) {
  const cookies = typeof rawCookies === "string" ? JSON.parse(rawCookies) : rawCookies;
  if (!Array.isArray(cookies)) throw new Error("cookies must be JSON array");

  return cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain === ".www.linkedin.com" ? ".linkedin.com" : c.domain,
    path: c.path || "/",
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    expires: c.expirationDate ? Math.floor(c.expirationDate) : undefined,
    sameSite:
      c.sameSite === "no_restriction" ? "None" :
      c.sameSite === "lax" ? "Lax" :
      c.sameSite === "strict" ? "Strict" : undefined
  }));
}

function makeAdminUrl(companyPageUrl) {
  let url = companyPageUrl.split("?")[0].replace(/\/$/, "");
  if (url.includes("/admin")) return url;
  return url + "/admin/dashboard/";
}

async function getDebug(page) {
  const title = await page.title().catch(() => "");
  const url = page.url();

  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");

  const buttons = await page.locator("button").evaluateAll(btns =>
    btns.map(b => ({
      text: (b.innerText || "").trim(),
      aria: b.getAttribute("aria-label"),
      title: b.getAttribute("title")
    })).slice(0, 80)
  ).catch(() => []);

  const links = await page.locator("a").evaluateAll(links =>
    links.map(a => ({
      text: (a.innerText || "").trim(),
      href: a.href
    })).slice(0, 80)
  ).catch(() => []);

  return {
    url,
    title,
    buttons,
    links,
    bodyText: bodyText.slice(0, 2500)
  };
}

async function clickSmart(page, patterns, timeout = 5000) {
  for (const p of patterns) {
    const locators = [
      page.getByRole("button", { name: p }).first(),
      page.getByRole("menuitem", { name: p }).first(),
      page.getByRole("link", { name: p }).first(),
      page.getByText(p).first()
    ];

    for (const locator of locators) {
      try {
        await locator.waitFor({ timeout });
        await locator.click();
        return true;
      } catch {}
    }
  }
  return false;
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "TRUS LinkedIn Publisher" });
});

app.post("/publish-linkedin", upload.single("image"), async (req, res) => {
  let browser;

  try {
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ") || auth.replace("Bearer ", "") !== API_KEY) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const { companyPageUrl, message, cookies } = req.body;

    if (!companyPageUrl || !message || !cookies) {
      return res.status(400).json({
        success: false,
        error: "companyPageUrl, message and cookies are required"
      });
    }

    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "en-US",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    });

    await context.addCookies(normalizeCookies(cookies));
    const page = await context.newPage();

    await page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    if (page.url().includes("/login")) {
      const debug = await getDebug(page);
      await browser.close();
      return res.status(401).json({
        success: false,
        error: "LinkedIn cookies expired or invalid",
        debug
      });
    }

    await page.goto(makeAdminUrl(companyPageUrl), {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(12000);

    let debugBefore = await getDebug(page);

    if (
      debugBefore.title.toLowerCase().includes("access denied") ||
      debugBefore.bodyText.toLowerCase().includes("rate limited") ||
      debugBefore.bodyText.toLowerCase().includes("cloudflare")
    ) {
      await browser.close();
      return res.status(429).json({
        success: false,
        error: "LinkedIn blocked Render IP with Cloudflare / rate limit",
        debug: debugBefore
      });
    }

    const createClicked = await clickSmart(page, [
      /^\+?\s*create$/i,
      /^create$/i,
      /^erstellen$/i,
      /^erstellen\s*$/i
    ], 8000);

    await page.waitForTimeout(4000);

    let postClicked = false;

    if (createClicked) {
      postClicked = await clickSmart(page, [
        /^post$/i,
        /post/i,
        /^beitrag$/i,
        /beitrag/i,
        /start a post/i,
        /create a post/i
      ], 8000);
    }

    if (!postClicked) {
      postClicked = await clickSmart(page, [
        /start a post/i,
        /create a post/i,
        /share a post/i,
        /^post$/i,
        /beitrag/i
      ], 8000);
    }

    if (!postClicked) {
      const debug = await getDebug(page);
      await browser.close();
      return res.status(500).json({
        success: false,
        error: "Could not find Start/Create/Post button",
        createClicked,
        debug
      });
    }

    await page.waitForTimeout(5000);

    const editor = page.locator('[contenteditable="true"]').first();
    await editor.waitFor({ timeout: 20000 });
    await editor.click();
    await page.keyboard.insertText(message);

    await page.waitForTimeout(3000);

    if (req.file) {
      await clickSmart(page, [
        /photo/i,
        /image/i,
        /media/i,
        /foto/i,
        /bild/i,
        /medien/i
      ], 8000);

      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(req.file.path);
      await page.waitForTimeout(12000);
    }

    const publishClicked = await clickSmart(page, [
      /^post$/i,
      /^publish$/i,
      /^veröffentlichen$/i,
      /^beitrag posten$/i,
      /^teilen$/i
    ], 15000);

    if (!publishClicked) {
      const debug = await getDebug(page);
      await browser.close();
      return res.status(500).json({
        success: false,
        error: "Could not find final Publish/Post button",
        debug
      });
    }

    await page.waitForTimeout(10000);
    await browser.close();

    return res.json({
      success: true,
      message: "LinkedIn post published"
    });

  } catch (error) {
    if (browser) await browser.close();
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`TRUS LinkedIn Publisher running on port ${PORT}`);
  
});
