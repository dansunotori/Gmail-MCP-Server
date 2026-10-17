#!/usr/bin/env node
import { getThreadCommand } from './commands.js';
import { main } from './common.js';

void main('gmail-get-thread', getThreadCommand);
