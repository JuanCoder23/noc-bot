'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'samples', 'alerts');

/** Read a sample alert by basename, e.g. load('ecs-cpu-triggered'). */
function load(name) {
  return fs.readFileSync(path.join(DIR, name + '.txt'), 'utf8');
}

function names() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, ''));
}

module.exports = { load, names };
