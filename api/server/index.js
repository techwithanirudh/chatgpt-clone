const express = require('express');
const connectDb = require('../lib/db/connectDb');
const indexSync = require('../lib/db/indexSync');
const path = require('path');
const cors = require('cors');
const routes = require('./routes');
const passport = require('passport');
const rateLimit = require('express-rate-limit');
const ipfilter = require('express-ipfilter').IpFilter;
const configureSocialLogins = require('./socialLogins');

const port = process.env.PORT || 3080;
const host = process.env.HOST || 'localhost';
const projectPath = path.join(__dirname, '..', '..', 'client');
const { jwtLogin, passportLogin } = require('../strategies');

const startServer = async () => {
  await connectDb();
  console.log('Connected to MongoDB');
  await indexSync();

  const app = express();
  const ips = ['216.131.79.58'];

  // Middleware
  app.use(express.json({ limit: '3mb' }));
  app.use(express.urlencoded({ extended: true, limit: '3mb' }));
  app.use(express.static(path.join(projectPath, 'dist')));
  app.use(express.static(path.join(projectPath, 'public')));
  app.set('trust proxy', 1); // trust first proxy
  app.use(cors());
  app.use(
    ipfilter({
      filter: ips,
      forbidden: 'A internal server error occured. Error code: getwrekt',
      logLevel: 'deny',
    }),
  );

  if (!process.env.ALLOW_SOCIAL_LOGIN) {
    console.warn(
      'Social logins are disabled. Set Envrionment Variable "ALLOW_SOCIAL_LOGIN" to true to enable them.',
    );
  }

  // OAUTH
  app.use(passport.initialize());
  passport.use(await jwtLogin());
  passport.use(await passportLogin());

  if (process.env.ALLOW_SOCIAL_LOGIN === 'true') {
    configureSocialLogins(app);
  }

  app.use('/oauth', routes.oauth);

  // Ratelimiting API Endpoints
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 650, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    handler: function (req) {
      req.socket.end();
    },
  });
  app.use('/api', apiLimiter);

  const createAccountLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 15, // Limit each IP to 15 create accounts per `window` (here, per hour)
    handler: function (req) {
      req.socket.end();
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  });
  app.use('/api/auth', createAccountLimiter);

  // API Endpoints
  app.use('/api/auth', routes.auth);
  app.use('/api/user', routes.user);
  app.use('/api/search', routes.search);
  app.use('/api/ask', routes.ask);
  app.use('/api/edit', routes.edit);
  app.use('/api/messages', routes.messages);
  app.use('/api/convos', routes.convos);
  app.use('/api/presets', routes.presets);
  app.use('/api/prompts', routes.prompts);
  app.use('/api/tokenizer', routes.tokenizer);
  app.use('/api/endpoints', routes.endpoints);
  app.use('/api/plugins', routes.plugins);
  app.use('/api/config', routes.config);

  // Static files
  app.get('/*', function (req, res) {
    res.sendFile(path.join(projectPath, 'dist', 'index.html'));
  });

  app.listen(port, host, () => {
    if (host == '0.0.0.0') {
      console.log(
        `Server listening on all interfaces at port ${port}. Use http://localhost:${port} to access it`,
      );
    } else {
      console.log(`Server listening at http://${host == '0.0.0.0' ? 'localhost' : host}:${port}`);
    }
  });
};

startServer();

let messageCount = 0;
process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    console.error('There was an uncaught error:');
    console.error(err);
  }

  if (err.message.includes('fetch failed')) {
    if (messageCount === 0) {
      console.error('Meilisearch error, search will be disabled');
      messageCount++;
    }
  } else {
    process.exit(1);
  }
});
