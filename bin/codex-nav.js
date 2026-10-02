#!/usr/bin/env node
'use strict';

const { runApp } = require('../src/app');

runApp().catch((error) => {
  console.error('');
  console.error('codex-nav failed:', error && error.message ? error.message : error);
  process.exitCode = 1;
});
