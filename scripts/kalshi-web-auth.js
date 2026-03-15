#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const { config } = require('../src/config');
const { loadWebSessionAuthFromFile } = require('../src/kalshiWebClient');

function question(promptText) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(promptText, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

async function main() {
  const statePath = path.resolve(config.kalshiWebAuthStatePath);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  console.log(`Opening Kalshi login in a browser window.`);
  console.log(`After you finish sign-in and 2FA, leave the browser on the Kalshi Transfers page.`);
  console.log(`Auth state will be saved to: ${statePath}`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto('https://kalshi.com/sign-in?redirect=%2Faccount%2Fbanking', { waitUntil: 'domcontentloaded' });
    await question('Press Enter after you are fully logged in and the Transfers page is visible...');

    if (!String(page.url()).includes('/account/banking')) {
      await page.goto('https://kalshi.com/account/banking', { waitUntil: 'domcontentloaded' });
    }

    await page.waitForTimeout(1500);
    await context.storageState({ path: statePath });

    const auth = loadWebSessionAuthFromFile(statePath);
    if (!auth) {
      throw new Error('Saved storage state does not contain Kalshi sessions cookie or csrfToken');
    }

    console.log('');
    console.log('Kalshi web auth saved successfully.');
    console.log(`User ID: ${auth.userId}`);
    console.log(`State file: ${statePath}`);
    console.log('');
    console.log('Next step: restart `npm run monitor:api` so the dashboard can use deposit-based invested capital automatically.');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('');
  console.error('Kalshi web auth setup failed.');
  console.error(error?.message || error);
  process.exitCode = 1;
});
