const path = require('path');
const express = require('express');
const jobsRouter = require('./routes/jobs');
const reportsRouter = require('./routes/reports');
const hugoRouter = require('./routes/hugo');
const socialCommentsRouter = require('./routes/social-comments');
const socialConversationsRouter = require('./routes/social-conversations');
const liquidityCycleRouter = require('./routes/liquidity-cycle');
const bcuUsuraRateRouter = require('./routes/bcu-usura-rate');
const competitorActivityPredictionsRouter = require('./routes/competitor-activity-predictions');
const marketPatternsRouter = require('./routes/market-patterns');
const mlNotesRouter = require('./routes/ml-notes');
const assistRouter = require('./routes/assist');
const authRouter = require('./routes/auth');
const { meHandler } = require('./routes/auth');
const { requireAuth } = require('./middleware/auth');
const {
  requireDashboardPermission,
  enforceMappedSectionPermission,
  requireAdmin,
} = require('./middleware/requireDashboardPermission');
const adminUsersRouter = require('./routes/admin-users');
const logger = require('./lib/logger');
const smsShortLinksRouter = require('./routes/sms-short-links');
const trackingEventsRouter = require('./routes/tracking-events');
const miplanHandoffRouter = require('./routes/miplan-handoff');
const emailUnsubscribeRouter = require('./routes/email-unsubscribe');
const emailClickRouter = require('./routes/email-click');

const app = express();

const EMAIL_ASSETS_ROOT = path.join(__dirname, '..', 'public', 'email-assets');

// Public Credizona tracking ingest — HMAC auth, must run before requireAuth.
// Own JSON parser so rawBody is available for HMAC and other routes stay unchanged.
app.use(
  '/tracking',
  express.json({
    limit: '4kb',
    verify: trackingEventsRouter.attachRawBody,
  }),
  trackingEventsRouter,
  trackingEventsRouter.jsonErrorHandler,
);
// Credizona → JANUS handoff emit + Mi Plan → JANUS redeem (dedicated secrets).
app.use(
  '/internal/miplan',
  express.json({
    limit: '8kb',
    verify: miplanHandoffRouter.attachRawBody,
  }),
  miplanHandoffRouter,
  miplanHandoffRouter.jsonErrorHandler,
);
app.use(express.json());
// Public SMS short-link redirects — must run before requireAuth.
app.use(smsShortLinksRouter);
// Public email unsubscribe (GET confirm / POST suppress) — before requireAuth.
app.use(emailUnsubscribeRouter);
// Public email click redirect (GET records event; HEAD does not) — before requireAuth.
app.use(emailClickRouter);
// Public email HTML assets only (Encuesta STEP1–3). Must run before requireAuth.
// Does NOT expose the rest of public/ — that remains behind requireAuth below.
app.use(
  '/email-assets',
  express.static(EMAIL_ASSETS_ROOT, {
    index: false,
    fallthrough: false,
  }),
  function emailAssetsStaticError(err, req, res, next) {
    const code = Number(err && (err.statusCode || err.status)) || 0;
    if (code >= 400 && code < 500) {
      res.sendStatus(code);
      return;
    }
    next(err);
  },
);
// login / logout / bootstrap (allowlisted inside requireAuth)
app.use('/', authRouter);
app.use(requireAuth);
app.get('/api/auth/me', meHandler);
// Admin-only user management (UX tab "Administrar"; real auth here)
app.use('/api/admin', requireAdmin, adminUsersRouter);

app.use(express.static('public'));

// Mixed routers: section resolved from src/middleware/dashboardSections.js
app.use('/jobs', enforceMappedSectionPermission, jobsRouter);
app.use('/reports', enforceMappedSectionPermission, reportsRouter);
app.use('/hugo', enforceMappedSectionPermission, hugoRouter);

// Dedicated section mounts (explicit requireDashboardPermission)
app.use(
  '/api/social-comments',
  requireDashboardPermission('inbox'),
  socialCommentsRouter,
);
app.use(
  '/api/social-conversations',
  requireDashboardPermission('inbox'),
  socialConversationsRouter,
);
app.use(
  '/api/liquidity-cycle',
  requireDashboardPermission('meta'),
  liquidityCycleRouter,
);
app.use(
  '/api/bcu-usura-rate',
  requireDashboardPermission('meta'),
  bcuUsuraRateRouter,
);
app.use(
  '/competitor-activity-predictions',
  requireDashboardPermission('market'),
  competitorActivityPredictionsRouter,
);
app.use(
  '/market-patterns',
  requireDashboardPermission('market'),
  marketPatternsRouter,
);
app.use('/ml-notes', requireDashboardPermission('market'), mlNotesRouter);
app.use('/assist', requireDashboardPermission('market'), assistRouter);

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
