#!/usr/bin/env node
import { listInboxThreadsCommand } from './commands.js';
import { main } from './common.js';

void main('gmail-list-inbox-threads', listInboxThreadsCommand);
