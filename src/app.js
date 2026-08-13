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
const authRouter = require('./routes/auth');
const { meHandler } = require('./routes/auth');
const { requireAuth } = require('./middleware/auth');
const {
  requireDashboardPermission,
  enforceMappedSectionPermission,
} = require('./middleware/requireDashboardPermission');
const logger = require('./lib/logger');

const app = express();

app.use(express.json());
// login / logout / bootstrap (allowlisted inside requireAuth)
app.use('/', authRouter);
app.use(requireAuth);
app.get('/api/auth/me', meHandler);

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

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
