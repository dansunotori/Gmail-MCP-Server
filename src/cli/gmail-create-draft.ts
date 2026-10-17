#!/usr/bin/env node
import { createDraftCommand } from './commands.js';
import { main } from './common.js';

void main('gmail-create-draft', createDraftCommand);
