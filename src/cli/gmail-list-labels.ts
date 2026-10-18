#!/usr/bin/env node
import { listLabelsCommand } from './commands.js';
import { main } from './common.js';

void main('gmail-list-labels', listLabelsCommand);
