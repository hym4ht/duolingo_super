// src/tempmail.js
// Temp mail logic ported from contoh.js (fetch + cheerio, NO Playwright browser needed)
// Credits: originally from ChatGPT Account Creator project

import * as cheerio from 'cheerio';
import { faker } from '@faker-js/faker';

/**
 * Generate a random string of given length (lowercase alphanumeric)
 */
function randstr(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch available domains from generator.email using cheerio scraping.
 * Returns a random domain string (e.g. "jagomail.com")
 */
async function getRandomDomain() {
  const res = await fetch('https://generator.email/', {
    method: 'GET',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'accept-encoding': 'gzip, deflate, br',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  const text = await res.text();
  const $ = cheerio.load(text);
  const domains = [];

  $('.e7m.tt-suggestions').find('div > p').each(function (_, element) {
    domains.push($(element).text().trim());
  });

  if (domains.length === 0) {
    throw new Error('No domains found from generator.email — site structure may have changed');
  }

  return domains[Math.floor(Math.random() * domains.length)];
}

/**
 * Generate a random temp email address.
 * Returns: { email, username, domain }
 */
export async function generateTempEmail() {
  const firstName = faker.person.firstName().replace(/["']/g, '');
  const lastName = faker.person.lastName().replace(/["']/g, '');
  const domain = await getRandomDomain();
  const randomStr = randstr(5);

  const username = `${firstName}${lastName}${randomStr}`.toLowerCase();
  const email = `${username}@${domain}`;

  return { email, username, domain };
}

/**
 * Poll generator.email inbox for a Duolingo verification code or link.
 * Uses the same cookie-based approach as contoh.js.
 *
 * @param {string} email  - Full email address (e.g. user@jagomail.com)
 * @param {number} maxRetries - How many times to poll (default 10)
 * @param {number} delaySeconds - Seconds between polls (default 5)
 * @returns {string|null} - Verification link or OTP code, or null if not found
 */
export async function waitForVerificationEmail(email, maxRetries = 10, delaySeconds = 5) {
  const [username, domain] = email.split('@');

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch('https://generator.email/', {
        method: 'GET',
        headers: {
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
          'cookie': `surl=${domain}/${username}`,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      const text = await response.text();
      const $ = cheerio.load(text);

      // Try to get email subject / content from inbox
      const emailContent = $('#email-table > div.e7m.list-group-item.list-group-item-info > div.e7m.subj_div_45g45gg').text().trim();

      if (emailContent && emailContent.length > 0) {
        // Look for 6-digit OTP
        const codeMatch = emailContent.match(/\d{6}/);
        if (codeMatch) return codeMatch[0];

        // If pure numeric, return as-is
        if (/^\d+$/.test(emailContent)) return emailContent;
      }

      // Also look for verification links directly in page HTML (Duolingo may put them)
      const verifyLink = $('a[href*="duolingo"]').filter(function () {
        const href = $(this).attr('href') || '';
        return href.includes('verify') || href.includes('confirm') || href.includes('email');
      }).attr('href');

      if (verifyLink) return verifyLink;

    } catch (e) {
      // ignore and retry
    }

    if (attempt < maxRetries - 1) {
      console.log(`  ⏳ [tempmail] Menunggu email verifikasi... (${attempt + 1}/${maxRetries})`);
      await sleep(delaySeconds * 1000);
    }
  }

  return null;
}
