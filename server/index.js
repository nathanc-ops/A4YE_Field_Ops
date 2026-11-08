'use strict';
const { open } = require('./db');
const { createApp } = require('./app');

const db = open();
const port = Number(process.env.PORT || 3000);
createApp(db).listen(port, () => console.log(`A4YE Field Ops running at http://localhost:${port}`));
