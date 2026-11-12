import http from 'node:http';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const SESSION_ID = 'ses_e2fe41ebfffefjY7L8ka4XTBXU'; // Your active session ID
const MESSAGE_FILE = './incoming_messages.txt';
const WEBHOOK_PORT = 3005;

const OPENCODE_BIN = 'C:\\nvm4w\\nodejs\\opencode.cmd';

let isAgentBusy = false;
let hasUnreadMessages = false;

function wakeAgent() {
  if (isAgentBusy || !hasUnreadMessages) return;

  isAgentBusy = true;
  hasUnreadMessages = false;

  console.log('\n[Bridge] Waking up OpenCode agent...');
  const prompt = `New messages were appended to ${MESSAGE_FILE}. Read the latest lines at the bottom of the file and respond.`;

  // No --server flag needed! Connects directly to OpenCode's local background service
  const child = spawn(
    `${OPENCODE_BIN} run --session ${SESSION_ID} --auto "${prompt}"`,
    {
      stdio: 'inherit',
      shell: true
    }
  );

  child.on('error', (err) => {
    isAgentBusy = false;
    console.error('[Bridge Error] Failed to start opencode:', err.message);
  });

  child.on('close', (code) => {
    isAgentBusy = false;
    console.log(`\n[OpenCode] Agent finished (exit code ${code}) and is now IDLE.`);

    if (hasUnreadMessages) {
      wakeAgent();
    }
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const data = JSON.parse(body);
      const newText = data.message?.trim();

      if (newText) {
        const entry = `[${new Date().toISOString()}] ${newText}\n`;
        await fs.appendFile(MESSAGE_FILE, entry, 'utf8');
        console.log(`\n[Webhook] Saved new message: "${newText}"`);
        hasUnreadMessages = true;
        wakeAgent();
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(WEBHOOK_PORT, () => {
  console.log(`[Webhook] Listening on http://localhost:${WEBHOOK_PORT}/webhook`);
});
