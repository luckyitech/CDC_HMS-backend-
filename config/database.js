const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'mysql',
    logging: false,
    pool: {
      max: 20,        // allow up to 20 simultaneous DB connections
      min: 2,         // keep at least 2 alive
      acquire: 30000, // wait max 30s to get a connection before erroring
      idle: 10000,    // release idle connections after 10s
    },
  }
);

module.exports = sequelize;
