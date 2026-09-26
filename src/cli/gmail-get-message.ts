#!/usr/bin/env node
import { getMessageCommand } from './commands.js';
import { main } from './common.js';

void main('gmail-get-message', getMessageCommand);
