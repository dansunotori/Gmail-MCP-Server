#!/usr/bin/env node
import { listMessageIdsCommand } from './commands.js';
import { main } from './common.js';

void main('gmail-list-message-ids', listMessageIdsCommand);
