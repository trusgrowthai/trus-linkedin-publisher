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

async function clickByText(page, patterns, timeout = 4000) {
  for (const p of patterns) {
    try {
      const el = page.getByText(p).first();
      await el.waitFor({ timeout });
      await el.click();
      return true;
    } catch {}
  }
  return false;
}

async function clickByRole(page, patterns, timeout = 4000) {
  for (const p of patterns) {
    try {
      const el = page.getByRole("button", { name: p }).first();
      await el.waitFor({ timeout });
      await el.click();
      return true;
    } catch {}
  }
  return false;
}

async function debugPage(page) {
  const title = await page.title().catch(() => "");
  const url = page.url();
  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  return { url, title, bodyText: bodyText.slice(0, 3000) };
}

function makeAdminUrl(companyPageUrl) {
  let url = companyPageUrl.split("?")[0].replace(/\/$/, "");
  if (url.includes("/admin")) return url;
  return url + "/admin/dashboard/";
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
      locale: "en-US"
    });

    await context.addCookies(normalizeCookies(cookies));
    const page = await context.newPage();

    await page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    if (page.url().includes("/login")) {
      await browser.close();
      return res.status(401).json({
        success: false,
        error: "LinkedIn cookies expired or invalid"
      });
    }

    await page.goto(makeAdminUrl(companyPageUrl), {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(12000);

    let createClicked =
      await clickByRole(page, [/create/i, /erstellen/i], 7000) ||
      await clickByText(page, [/create/i, /erstellen/i], 7000);

    await page.waitForTimeout(3000);

    let startClicked = false;

    if (createClicked) {
      startClicked =
        await clickByRole(page, [/post/i, /beitrag/i, /start a post/i, /create a post/i], 7000) ||
        await clickByText(page, [/post/i, /beitrag/i, /start a post/i, /create a post/i], 7000);
    }

    if (!startClicked) {
      startClicked =
        await clickByRole(page, [/start a post/i, /create a post/i, /share a post/i, /post/i, /beitrag/i], 7000) ||
        await clickByText(page, [/start a post/i, /create a post/i, /share a post/i, /post/i, /beitrag/i], 7000);
    }

    if (!startClicked) {
      const debug = await debugPage(page);
      await browser.close();
      return res.status(500).json({
        success: false,
        error: "Could not find Start a post button",
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
      await clickByRole(page, [/photo/i, /image/i, /media/i, /foto/i, /bild/i, /medien/i], 8000);
      await clickByText(page, [/photo/i, /image/i, /media/i, /foto/i, /bild/i, /medien/i], 8000);

      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(req.file.path);

      await page.waitForTimeout(12000);
    }

    const postButton = page.getByRole("button", { name: /^post$/i }).last();
    await postButton.waitFor({ timeout: 20000 });
    await postButton.click();

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
