const express = require('express');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

const EMAIL        = process.env.EMAIL_USER;
const APP_PASSWORD = process.env.EMAIL_PASS;
const CRON_SECRET  = process.env.CRON_SECRET;
const IMAP_HOST    = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAP_PORT    = Number(process.env.IMAP_PORT) || 993;

// State tracking to prevent duplicate clicks and overlapping Chrome instances
let lastProcessedUid = null;
let isRunning = false;

// ─── Link extractor ────────────────────────────────────────────────────────

function extractVerifyLink(html, text) {
  if (html) {
    const anchorRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html)) !== null) {
      const url       = match[1].replace(/&amp;/g, '&');
      const innerText = match[2].replace(/<[^>]+>/g, '').trim().toLowerCase();
      if (
        url.includes('discord.com') &&
        (innerText.includes('verify') || innerText.includes('authorize') || innerText.includes('confirm'))
      ) {
        console.log(`Found verify link by anchor text "${innerText}": ${url}`);
        return url;
      }
    }

    const ctx1 = /verify[\s\S]{0,300}?href=["']([^"']*discord\.com[^"']+)["']/gi.exec(html);
    if (ctx1) {
      const url = ctx1[1].replace(/&amp;/g, '&');
      console.log(`Found by forward context: ${url}`);
      return url;
    }

    const ctx2 = /href=["']([^"']*discord\.com[^"']+)["'][\s\S]{0,300}?verify/gi.exec(html);
    if (ctx2) {
      const url = ctx2[1].replace(/&amp;/g, '&');
      console.log(`Found by reverse context: ${url}`);
      return url;
    }
  }

  if (text) {
    const m = text.match(/https:\/\/click\.discord\.com\/[^\s]+/);
    if (m) {
      console.log(`Found link from plain text: ${m[0]}`);
      return m[0];
    }
  }

  return null;
}

// ─── IMAP ──────────────────────────────────────────────────────────────────

async function getVerifyLink() {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: EMAIL, pass: APP_PASSWORD },
    logger: false,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

  await client.connect();

  let mailboxName = '[Gmail]/All Mail';
  let lock;
  try {
    lock = await client.getMailboxLock(mailboxName);
    console.log(`Opened mailbox: ${mailboxName}`);
  } catch {
    mailboxName = 'INBOX';
    lock = await client.getMailboxLock(mailboxName);
    console.log(`Fell back to: ${mailboxName}`);
  }

  try {
    // IMAP 'since' searches by calendar day; we filter exact minutes after fetching
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    let messages = await client.search({ from: '@discord.com', since }, { uid: true });
    if (!messages?.length) {
      messages = await client.search({ body: 'discord.com', since }, { uid: true });
    }
    if (!messages?.length) {
      console.log('No Discord emails found today.');
      return null;
    }

    const latestId = messages[messages.length - 1];
    console.log(`Found ${messages.length} Discord email(s) today. Latest UID: ${latestId}`);

    // Skip immediately if we already verified this exact email UID
    if (latestId === lastProcessedUid) {
      console.log(`UID ${latestId} was already processed earlier — skipping.`);
      return null;
    }

    const msg    = await client.fetchOne(latestId, { source: true }, { uid: true });
    const parsed = await simpleParser(msg.source);

    const emailDate  = parsed.date ? new Date(parsed.date) : null;
    const ageMinutes = emailDate ? (Date.now() - emailDate.getTime()) / (1000 * 60) : 0;

    console.log(`Subject : ${parsed.subject}`);
    console.log(`Received: ${emailDate?.toISOString()} (${ageMinutes.toFixed(1)} mins ago)`);

    // Strict 15-minute freshness check so old emails from earlier today are ignored
    if (emailDate && ageMinutes > 15) {
      console.log(`Email is ${ageMinutes.toFixed(1)} mins old (> 15 min window) — marking UID ${latestId} as seen and skipping.`);
      lastProcessedUid = latestId;
      return null;
    }

    if (
      parsed.subject?.includes('Verify Discord Login') ||
      parsed.subject?.includes('Email Verification')
    ) {
      const link = extractVerifyLink(parsed.html, parsed.text);
      if (link) {
        return { link, uid: latestId };
      }
      console.log('Could not extract link from email.');
      lastProcessedUid = latestId;
    } else {
      console.log('Email is not a login verification email — skipping.');
      lastProcessedUid = latestId;
    }

    return null;
  } finally {
    lock.release();
    await client.logout();
  }
}

// ─── Puppeteer click ───────────────────────────────────────────────────────

async function clickWithBrowser(url) {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-crash-reporter',
      '--disable-extensions',
      '--no-first-run',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    console.log('Navigating to verify link...');

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    await new Promise(r => setTimeout(r, 3000));

    const title    = await page.title();
    const finalUrl = page.url();
    console.log(`Final URL : ${finalUrl}`);
    console.log(`Page title: ${title}`);

    return { status: response.status(), title, finalUrl };
  } finally {
    await browser.close();
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────

app.get('/verify', async (req, res) => {
  if (req.query.secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (isRunning) {
    console.log('⚠️ /verify already in progress — skipping overlapping request.');
    return res.status(200).json({ success: true, message: 'Verification already running' });
  }

  isRunning = true;
  console.log(`\n[${new Date().toISOString()}] /verify triggered`);

  try {
    const emailData = await getVerifyLink();
    if (!emailData) {
      return res.status(200).json({ success: true, message: 'No new verification email found (last 15 min)' });
    }

    const { link, uid } = emailData;
    console.log(`Clicking: ${link}`);
    const result = await clickWithBrowser(link);

    const verified =
      result.title.toLowerCase().includes('discord') &&
      !result.title.toLowerCase().includes('error');

    if (verified) {
      lastProcessedUid = uid;
      console.log(`✅ Login verified! Marked UID ${uid} as completed.`);
      return res.status(200).json({ success: true, message: 'Login verified', ...result });
    } else {
      console.log('⚠️ Clicked but verification uncertain — check title/URL above.');
      return res.status(200).json({ success: false, message: 'Clicked but verification uncertain', ...result });
    }
  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    isRunning = false;
  }
});

app.get('/', (_, res) => res.status(200).send('Discord verifier is running.'));

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

// ─── Global Error Handlers (Prevents the site from crashing) ───────────────

process.on('unhandledRejection', (reason) => {
  console.error('🚨 CRITICAL: Unhandled Promise Rejection. The site is still running.', reason);
});

process.on('uncaughtException', (err) => {
  console.error('🚨 CRITICAL: Uncaught Exception. The site is still running.', err);
});