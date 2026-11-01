const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const puppeteer = require('puppeteer');

const EMAIL        = process.env.EMAIL_USER;
const APP_PASSWORD = process.env.EMAIL_PASS;
const IMAP_HOST    = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAP_PORT    = Number(process.env.IMAP_PORT) || 993;

// ─── Link Extractor ────────────────────────────────────────────────────────

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

// ─── Browser Clicker ───────────────────────────────────────────────────────

async function clickWithBrowser(url) {
  console.log('Launching Chrome on GitHub runner...');
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    console.log('Navigating to Discord verification link...');
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Allow Discord's frontend JS to complete the IP/location authorization handshake
    await new Promise(r => setTimeout(r, 4000));

    const title    = await page.title();
    const finalUrl = page.url();
    console.log(`Final URL : ${finalUrl}`);
    console.log(`Page title: ${title}`);

    return { status: response ? response.status() : 0, title, finalUrl };
  } finally {
    await browser.close();
  }
}

// ─── Main IMAP + Verification Flow ─────────────────────────────────────────

async function runVerifier() {
  if (!EMAIL || !APP_PASSWORD) {
    throw new Error('Missing EMAIL_USER or EMAIL_PASS environment variables.');
  }

  console.log(`[${new Date().toISOString()}] Starting Discord verification check...`);

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: EMAIL, pass: APP_PASSWORD },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
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
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Only search UNSEEN (unread) emails from Discord so we never click the same email twice
    let messages = await client.search({ unseen: true, from: '@discord.com', since }, { uid: true });
    if (!messages?.length) {
      messages = await client.search({ unseen: true, body: 'discord.com', since }, { uid: true });
    }

    if (!messages?.length) {
      console.log('No unread Discord emails found today. Nothing to do.');
      return;
    }

    const latestId = messages[messages.length - 1];
    console.log(`Found ${messages.length} unread Discord email(s). Checking latest UID: ${latestId}`);

    const msg    = await client.fetchOne(latestId, { source: true }, { uid: true });
    const parsed = await simpleParser(msg.source);

    const emailDate  = parsed.date ? new Date(parsed.date) : null;
    const ageMinutes = emailDate ? (Date.now() - emailDate.getTime()) / (1000 * 60) : 0;

    console.log(`Subject : ${parsed.subject}`);
    console.log(`Received: ${emailDate?.toISOString()} (${ageMinutes.toFixed(1)} mins ago)`);

    // If the email is older than 20 minutes, mark it as read so we don't keep checking it
    if (emailDate && ageMinutes > 20) {
      console.log(`Email is ${ageMinutes.toFixed(1)} mins old (> 20 min window). Marking as read and skipping.`);
      await client.messageFlagsAdd(latestId, ['\\Seen'], { uid: true });
      return;
    }

    if (
      parsed.subject?.includes('Verify Discord Login') ||
      parsed.subject?.includes('Email Verification')
    ) {
      const link = extractVerifyLink(parsed.html, parsed.text);
      if (!link) {
        console.log('Could not extract verify link from email. Marking as read.');
        await client.messageFlagsAdd(latestId, ['\\Seen'], { uid: true });
        return;
      }

      console.log(`Clicking verification link: ${link}`);
      const result = await clickWithBrowser(link);

      const verified =
        result.title.toLowerCase().includes('discord') &&
        !result.title.toLowerCase().includes('error');

      if (verified) {
        // Mark the email as Read (\Seen) in Gmail so future 5-min runs skip it
        await client.messageFlagsAdd(latestId, ['\\Seen'], { uid: true });
        console.log(`✅ Login verified! Marked UID ${latestId} as Read in Gmail.`);
      } else {
        console.log('⚠️ Clicked link, but verification title looked uncertain. Will retry next run.');
      }
    } else {
      console.log('Unread Discord email is not a login verification email — marking as read.');
      await client.messageFlagsAdd(latestId, ['\\Seen'], { uid: true });
    }
  } finally {
    lock.release();
    await client.logout();
  }
}

runVerifier().catch(err => {
  console.error('❌ Fatal Error:', err);
  process.exit(1);
});