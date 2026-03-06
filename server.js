require('dotenv').config();
const app = require('./app');
const sequelize = require('./config/database');
require('./models');  // registers all models with sequelize before sync runs

const PORT = process.env.PORT || 3000;

// Prevent unhandled promise rejections from crashing the server
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Promise Rejection:', reason?.message || reason);
});

// Prevent uncaught exceptions from crashing the server
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught Exception:', err.message);
});

// Verify DB connection, then start the server
sequelize.authenticate()
  .then(async () => {
    console.log('MySQL connection established successfully.');

    // Sync models — alter: true adds missing columns and fixes schema
    return sequelize.sync({ alter: true });
  })
  .then(() => {
    console.log('Models synced.');
    app.listen(PORT, () => {
      console.log(`CDC HMS API running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database connection failed:', err.message);
    process.exit(1);
  });
