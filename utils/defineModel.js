const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Wraps sequelize.define so every model file only needs one import
const defineModel = (name, fields, options = {}) => sequelize.define(name, fields, options);

module.exports = { defineModel, DataTypes };
