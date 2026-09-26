#!/usr/bin/env node
import { batchFetchWindowCommand } from './commands.js';
import { main } from './common.js';

void main('gmail-batch-fetch-window', batchFetchWindowCommand);
