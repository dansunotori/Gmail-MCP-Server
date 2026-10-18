#!/usr/bin/env node
import { getFilterCommand } from './commands.js';
import { main } from './common.js';

void main('gmail-get-filter', getFilterCommand);
