const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

module.exports = readFileSync(resolve(__dirname, './schema.graphql'), 'utf8');
