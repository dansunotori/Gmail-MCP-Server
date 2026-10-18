#!/usr/bin/env node
import { batchGetIndexMetadataCommand } from './commands.js';
import { main } from './common.js';

void main('gmail-batch-get-index-metadata', batchGetIndexMetadataCommand);
