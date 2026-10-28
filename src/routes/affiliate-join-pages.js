'use strict';

/**
 * Public affiliate landing + terms (mounted at /affiliates, before requireAuth).
 * Does not expose the rest of public/.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const router = express.Router();

const AFFILIATES_ROOT = path.join(__dirname, '..', '..', 'public', 'affiliates');
const TERMS_V2_INC = path.join(AFFILIATES_ROOT, 'affiliate-terms-v2.inc.html');
const TERMS_SHELL = path.join(AFFILIATES_ROOT, 'terms-shell.html');
const JOIN_HTML = path.join(AFFILIATES_ROOT, 'join.html');
const CACHE = {
  termsHtml: null,
  joinHtml: null,
};

function readUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function buildTermsHtml(shellPath, incPath, placeholder) {
  const shell = readUtf8(shellPath);
  const body = fs.existsSync(incPath) ? readUtf8(incPath) : '';
  return shell.replace(placeholder, body);
}

function termsHtml() {
  if (process.env.NODE_ENV === 'production') {
    if (!CACHE.termsHtml) {
      CACHE.termsHtml = buildTermsHtml(
        TERMS_SHELL,
        TERMS_V2_INC,
        '<!-- AFFILIATE_TERMS_V2_BODY -->',
      );
    }
    return CACHE.termsHtml;
  }
  return buildTermsHtml(
    TERMS_SHELL,
    TERMS_V2_INC,
    '<!-- AFFILIATE_TERMS_V2_BODY -->',
  );
}

function joinHtml() {
  if (process.env.NODE_ENV === 'production') {
    if (!CACHE.joinHtml) {
      CACHE.joinHtml = readUtf8(JOIN_HTML);
    }
    return CACHE.joinHtml;
  }
  return readUtf8(JOIN_HTML);
}

function sendHtml(res, html) {
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(html);
}

router.get('/terms', function serveTerms(req, res, next) {
  try {
    sendHtml(res, termsHtml());
  } catch (err) {
    next(err);
  }
});

router.get('/join', function serveJoin(req, res, next) {
  try {
    sendHtml(res, joinHtml());
  } catch (err) {
    next(err);
  }
});

router.get('/logo.svg', function serveLogo(req, res, next) {
  res.sendFile(path.join(AFFILIATES_ROOT, 'logo.svg'), { maxAge: '7d' }, function (err) {
    if (err) next(err);
  });
});

router.get('/affiliates.css', function serveCss(req, res, next) {
  res.sendFile(path.join(AFFILIATES_ROOT, 'affiliates.css'), { maxAge: '1h' }, function (err) {
    if (err) next(err);
  });
});

router.get('/join.js', function serveJoinJs(req, res, next) {
  res.type('application/javascript');
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(AFFILIATES_ROOT, 'join.js'), function (err) {
    if (err) next(err);
  });
});

module.exports = router;
