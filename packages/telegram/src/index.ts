import { runClientTrain } from '@metro-labs/core/stations/train-boot';
import { accounts, loadAccounts } from './accounts.js';
import { createClient } from './client.js';
import { startInbound } from './inbound.js';
import { makeHandleCall } from './actions.js';

runClientTrain({ station: 'telegram', accounts, loadAccounts, createClient, startInbound, makeHandleCall });
