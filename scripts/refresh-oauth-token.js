#!/usr/bin/env node
/**
 * Refresh OAuth token so it includes both Gmail and Google Sheets scopes.
 * Removes config/token.json (if present) and runs the sign-in flow.
 * Use this if you get "Request had insufficient authentication scopes" (403) when appending to Sheets.
 *
 * Run: node scripts/refresh-oauth-token.js
 */

const path = require('path');
const fs = require('fs');

const TOKEN_PATH = path.join(__dirname, '..', 'config', 'token.json');

if (fs.existsSync(TOKEN_PATH)) {
  fs.unlinkSync(TOKEN_PATH);
  console.log('Removed old token. Opening browser to sign in with Gmail + Sheets scopes...');
} else {
  console.log('No existing token. Opening browser to sign in with Gmail + Sheets scopes...');
}

const { GmailManager } = require('../gmail-api');

GmailManager.fromClientSecret()
  .then(() => {
    console.log('Token saved to config/token.json. You can run the job search again.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
