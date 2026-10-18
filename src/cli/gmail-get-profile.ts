#!/usr/bin/env node
import { getProfileCommand } from './commands.js';
import { main } from './common.js';

void main('gmail-get-profile', getProfileCommand);
