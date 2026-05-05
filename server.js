const express = require('express');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

const EMAIL       = process.env.EMAIL_USER;
const APP_PASSWORD = process.env.EMAIL_PASS;
const CRON_SECRET = process.env.CRON_SECRET;
const IMAP_HOST   = process.env.IMAP_HOST || 'imap.gmail.com';

// ─── Link extractor ────────────────────────────────────────────────────────

function extractVerifyLink(html, text) {
  if (html) {
    // Strategy 1: find <a> whose visible text says "verify / authorize / confirm"
    const anchorRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html)) !== null) {
      const url      = match[1];
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
    // DEBUG: last 5 subjects
    const all = await client.search({ all: true }, { uid: true });
    if (!all?.length) {
      console.log('Mailbox is empty.');
      return null;
    }
    console.log(`Total messages: ${all.length}`);
    for (const uid of all.slice(-5)) {
      const m = await client.fetchOne(uid, { source: true }, { uid: true });
      const p = await simpleParser(m.source);
      console.log(` - ${p.subject} (${p.date?.toISOString()})`);
    }

    // Find Discord emails
    let messages = await client.search({ from: '@discord.com' }, { uid: true });
    if (!messages?.length) messages = await client.search({ body: 'discord.com' }, { uid: true });
    if (!messages?.length) { console.log('No Discord emails found.'); return null; }

    console.log(`Found ${messages.length} Discord emails. Sorting by date...`);

    // Sort by actual date — UIDs in All Mail are NOT date-ordered
    let latestUid = null, latestDate = null;
    for await (const msg of client.fetch(messages, { envelope: true }, { uid: true })) {
      const d = msg.envelope?.date ? new Date(msg.envelope.date) : null;
      console.log(` - UID ${msg.uid}: ${msg.envelope?.subject} (${d?.toISOString()})`);
      if (d && (!latestDate || d > latestDate)) { latestDate = d; latestUid = msg.uid; }
    }

    if (!latestUid) { console.log('Could not find latest email.'); return null; }
    console.log(`Latest: UID ${latestUid} @ ${latestDate.toISOString()}`);

    const msg = await client.fetchOne(latestUid, { source: true }, { uid: true });
    const parsed = await simpleParser(msg.source);
    console.log(`Subject: ${parsed.subject}`);

    if (parsed.subject?.includes('Verify Discord Login') || parsed.subject?.includes('Email Verification')) {
      const link = extractVerifyLink(parsed.html, parsed.text);
      if (link) return link;
      console.log('Could not extract link from email.');
    } else {
      console.log('Latest Discord email is not a verification email.');
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
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    console.log(`Navigating to verify link...`);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise(r => setTimeout(r, 3000)); // let JS settle

    const title = await page.title();
    const finalUrl = page.url();
    console.log(`Final URL : ${finalUrl}`);
    console.log(`Page title: ${title}`);

    return { status: response.status(), title, finalUrl };
  } finally {
    await browser.close();
  }
}

// ─── Route ─────────────────────────────────────────────────────────────────

app.get('/verify', async (req, res) => {
  if (req.query.secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log(`\n[${new Date().toISOString()}] /verify triggered`);

  try {
    const link = await getVerifyLink();
    if (!link) {
      return res.status(200).json({ success: true, message: 'No verification link found' });
    }

    console.log(`Clicking: ${link}`);
    const result = await clickWithBrowser(link);

    const verified = result.title.toLowerCase().includes('discord') &&
                     !result.title.toLowerCase().includes('error');

    if (verified) {
      console.log('✅ Login verified!');
      return res.status(200).json({ success: true, message: 'Login verified', ...result });
    } else {
      console.log('⚠️ Clicked but unsure if verified. Check title/URL above.');
      return res.status(200).json({ success: false, message: 'Clicked but verification uncertain', ...result });
    }
  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (_, res) => res.send('Discord verifier is running.'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
