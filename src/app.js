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

const app = express();

app.use(express.json());
// Public SMS short-link redirects — must run before requireAuth.
app.use(smsShortLinksRouter);
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
