#!/usr/bin/env node
import { downloadEmailCommand } from './commands.js';
import { main } from './common.js';

void main('gmail-download-email', downloadEmailCommand);
