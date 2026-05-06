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

// ─── Link extractor ────────────────────────────────────────────────────────

function extractVerifyLink(html, text) {
  if (html) {
    // Strategy 1: find <a> whose visible text says "verify / authorize / confirm"
    const anchorRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html)) !== null) {
      const url       = match[1];
      const innerText = match[2].replace(/<[^>]+>/g, '').trim().toLowerCase();
      if (
        url.includes('discord.com') &&
        (innerText.includes('verify') || innerText.includes('authorize') || innerText.includes('confirm'))
      ) {
        console.log(`Found verify link by anchor text "${innerText}": ${url}`);
        return url;
      }
    }

    // Strategy 2: href close to "verify" in the HTML
    const ctx1 = /verify[\s\S]{0,300}?href=["']([^"']*discord\.com[^"']+)["']/gi.exec(html);
    if (ctx1) { console.log(`Found by forward context: ${ctx1[1]}`); return ctx1[1]; }

    const ctx2 = /href=["']([^"']*discord\.com[^"']+)["'][\s\S]{0,300}?verify/gi.exec(html);
    if (ctx2) { console.log(`Found by reverse context: ${ctx2[1]}`); return ctx2[1]; }
  }

  // Strategy 3: plain text fallback
  if (text) {
    const m = text.match(/https:\/\/click\.discord\.com\/[^\s]+/);
    if (m) { console.log(`Found link from plain text: ${m[0]}`); return m[0]; }
  }

  return null;
}

// ─── IMAP ──────────────────────────────────────────────────────────────────

async function getVerifyLink() {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: EMAIL, pass: APP_PASSWORD },
    logger: false,
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
    // Search only emails from last 10 minutes — avoids sorting entirely
    // and guarantees we only act on a fresh verification email
    const since = new Date(Date.now() - 10 * 60 * 1000);

    let messages = await client.search({ from: '@discord.com', since }, { uid: true });
    if (!messages?.length) {
      messages = await client.search({ body: 'discord.com', since }, { uid: true });
    }
    if (!messages?.length) {
      console.log('No recent Discord emails found (last 10 min).');
      return null;
    }

    // With a 10-min window there will only ever be 1-2 emails max.
    // UIDs within such a narrow window ARE in order, so just take the last one.
    const latestId = messages[messages.length - 1];
    console.log(`Found ${messages.length} recent Discord email(s). Using UID: ${latestId}`);

    const msg    = await client.fetchOne(latestId, { source: true }, { uid: true });
    const parsed = await simpleParser(msg.source);
    console.log(`Subject : ${parsed.subject}`);
    console.log(`Received: ${parsed.date?.toISOString()}`);

    if (
      parsed.subject?.includes('Verify Discord Login') ||
      parsed.subject?.includes('Email Verification')
    ) {
      const link = extractVerifyLink(parsed.html, parsed.text);
      if (link) return link;
      console.log('Could not extract link from email.');
    } else {
      console.log('Email is not a login verification email — skipping.');
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
      '--single-process',          // Fixes thread/process limits on Railway
      '--no-zygote',               // Saves memory by not forking
      '--disable-crash-reporter',  // Stops the crashpad_handler that caused Error 11
      '--disable-extensions',
      '--no-first-run'
    ],
  });
  
  // ... rest of your code stays exactly the same

// ─── Route ─────────────────────────────────────────────────────────────────

app.get('/verify', async (req, res) => {
  if (req.query.secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log(`\n[${new Date().toISOString()}] /verify triggered`);

  try {
    const link = await getVerifyLink();
    if (!link) {
      return res.status(200).json({ success: true, message: 'No recent verification email found' });
    }

    console.log(`Clicking: ${link}`);
    const result = await clickWithBrowser(link);

    const verified =
      result.title.toLowerCase().includes('discord') &&
      !result.title.toLowerCase().includes('error');

    if (verified) {
      console.log('✅ Login verified!');
      return res.status(200).json({ success: true, message: 'Login verified', ...result });
    } else {
      console.log('⚠️  Clicked but verification uncertain — check title/URL above.');
      return res.status(200).json({ success: false, message: 'Clicked but verification uncertain', ...result });
    }
  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (_, res) => res.send('Discord verifier is running.'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));