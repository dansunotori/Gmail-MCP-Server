#!/usr/bin/env node
import { listFiltersCommand } from './commands.js';
import { main } from './common.js';

void main('gmail-list-filters', listFiltersCommand);
