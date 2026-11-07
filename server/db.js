import { Store } from './store.js';
import { DATA_DIR, DB_FILE } from './config.js';
import { acquireDataLock } from './dataLock.js';

export const releaseDataLock = acquireDataLock(DATA_DIR);
let instance;
try { instance = new Store(DB_FILE); }
catch (error) { releaseDataLock(); throw error; }
export const store = instance;
process.once('exit', releaseDataLock);
