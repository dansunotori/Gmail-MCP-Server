#!/usr/bin/env node
import { downloadAttachmentCommand } from './commands.js';
import { main } from './common.js';

void main('gmail-download-attachment', downloadAttachmentCommand);
