#!/usr/bin/env node
import { getAttachmentTextCommand } from './commands.js';
import { main } from './common.js';

void main('gmail-get-attachment-text', getAttachmentTextCommand);
