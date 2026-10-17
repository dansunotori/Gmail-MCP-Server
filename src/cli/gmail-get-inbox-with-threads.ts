#!/usr/bin/env node
import { getInboxWithThreadsCommand } from './commands.js';
import { main } from './common.js';

void main('gmail-get-inbox-with-threads', getInboxWithThreadsCommand);
