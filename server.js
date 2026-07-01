const express = require("express");
const multer = require("multer");
const { chromium } = require("playwright");

const app = express();
const upload = multer({ dest: "/tmp/uploads" });

app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

function normalizeCookies(rawCookies) {
  const cookies = typeof rawCookies === "string"
    ? JSON.parse(rawCookies)
    : rawCookies;

  if (!Array.isArray(cookies)) {
    throw new Error("cookies must be JSON array");
  }

  return cookies.map(c => {
    const cookie = {
      name: c.name,
      value: c.value,
      domain: c.domain === ".www.linkedin.com" ? ".linkedin.com" : c.domain,
      path: c.path || "/",
      httpOnly: !!c.httpOnly,
      secure: !!c.secure
    };

    if (c.expirationDate) {
      cookie.expires = Math.floor(c.expirationDate);
    }

    if (c.sameSite === "no_restriction") cookie.sameSite = "None";
    else if (c.sameSite === "lax") cookie.sameSite = "Lax";
    else if (c.sameSite === "strict") cookie.sameSite = "Strict";

    return cookie;
  });
}

async function clickIfExists(page, regex, timeout = 8000) {
  try {
    const el = page.getByText(regex).first();
    await el.waitFor({ timeout });
    await el.click();
    return true;
  } catch {
    return false;
  }
}

async function clickButtonIfExists(page, regex, timeout = 8000) {
  try {
    const btn = page.getByRole("button", { name: regex }).first();
    await btn.waitFor({ timeout });
    await btn.click();
    return true;
  } catch {
    return false;
  }
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

    const normalizedCookies = normalizeCookies(cookies);
    const imagePath = req.file ? req.file.path : null;

    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 }
    });

    await context.addCookies(normalizedCookies);

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

    await page.goto(companyPageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(6000);

    await clickIfExists(page, /view as admin/i, 10000);
    await page.waitForTimeout(7000);

    const startClicked =
      await clickButtonIfExists(page, /start a post/i, 10000) ||
      await clickIfExists(page, /start a post/i, 10000) ||
      await clickButtonIfExists(page, /create a post/i, 10000) ||
      await clickIfExists(page, /create a post/i, 10000) ||
      await clickButtonIfExists(page, /post as/i, 10000) ||
      await clickIfExists(page, /post as/i, 10000) ||
      await clickButtonIfExists(page, /share a post/i, 10000) ||
      await clickIfExists(page, /share a post/i, 10000) ||
      await clickButtonIfExists(page, /^post$/i, 10000) ||
      await clickIfExists(page, /^post$/i, 10000);

    if (!startClicked) {
      await browser.close();
      return res.status(500).json({
        success: false,
        error: "Could not find Start a post button"
      });
    }

    await page.waitForTimeout(4000);

    const editor = page.locator('[contenteditable="true"]').first();
    await editor.waitFor({ timeout: 20000 });
    await editor.click();
    await page.keyboard.insertText(message);

    await page.waitForTimeout(3000);

    if (imagePath) {
      await clickButtonIfExists(page, /photo|image|media/i, 8000);
      await clickIfExists(page, /photo|image|media/i, 8000);

      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(imagePath);

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
