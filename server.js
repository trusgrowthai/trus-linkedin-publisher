const express = require("express");
const multer = require("multer");
const { chromium } = require("playwright");

const app = express();
const upload = multer({ dest: "/tmp/uploads" });

app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const LINKEDIN_COOKIES = process.env.LINKEDIN_COOKIES;

function normalizeCookies(rawCookies) {
  const cookies = typeof rawCookies === "string"
    ? JSON.parse(rawCookies)
    : rawCookies;

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

async function clickIfExists(page, textRegex, timeout = 5000) {
  try {
    const locator = page.getByText(textRegex).first();
    await locator.waitFor({ timeout });
    await locator.click();
    return true;
  } catch {
    return false;
  }
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "TRUS LinkedIn Publisher" });
});

app.post("/publish-linkedin", upload.single("image"), async (req, res) => {
  try {
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ") || auth.replace("Bearer ", "") !== API_KEY) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const { companyPageUrl, message } = req.body;

    if (!companyPageUrl || !message) {
      return res.status(400).json({
        success: false,
        error: "companyPageUrl and message are required"
      });
    }

    if (!LINKEDIN_COOKIES) {
      return res.status(500).json({
        success: false,
        error: "LINKEDIN_COOKIES env is missing"
      });
    }

    const cookies = normalizeCookies(LINKEDIN_COOKIES);
    const imagePath = req.file ? req.file.path : null;

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const context = await browser.newContext();
    await context.addCookies(cookies);

    const page = await context.newPage();

    await page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(4000);

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

    await page.waitForTimeout(5000);

    await clickIfExists(page, /view as admin/i, 5000);

    await page.waitForTimeout(4000);

    const startClicked =
      await clickIfExists(page, /start a post/i, 8000) ||
      await clickIfExists(page, /create a post/i, 8000) ||
      await clickIfExists(page, /^post$/i, 8000);

    if (!startClicked) {
      await browser.close();
      return res.status(500).json({
        success: false,
        error: "Could not find Start a post button"
      });
    }

    await page.waitForTimeout(3000);

    const editor = page.locator('[contenteditable="true"]').first();
    await editor.waitFor({ timeout: 15000 });
    await editor.click();
    await page.keyboard.insertText(message);

    await page.waitForTimeout(2000);

    if (imagePath) {
      await clickIfExists(page, /photo|image|media/i, 5000);

      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(imagePath);

      await page.waitForTimeout(10000);
    }

    const postButton = page.getByRole("button", { name: /^post$/i }).last();
    await postButton.waitFor({ timeout: 15000 });
    await postButton.click();

    await page.waitForTimeout(10000);

    await browser.close();

    return res.json({
      success: true,
      message: "LinkedIn post published"
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`TRUS LinkedIn Publisher running on port ${PORT}`);
});
