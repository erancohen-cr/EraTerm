# EranTerm

Local-first desktop SSH manager for your servers: terminals, an SFTP file manager with drag & drop, live log tailing with level colours and search, and an AI assistant that only runs commands you approve.

## Features
- **Home**: all servers with search, favorites, edit/delete, connect
- **File Manager**: browse, upload/download (drag & drop, folders as tar.gz), delete, open any folder in a side terminal or the main terminal
- **Terminal**: full xterm shell + AI command suggestions (approve before run)
- **Logs**: multiple sources per server, Live tail on/off, INFO/WARN/ERROR colours, 200–5000 lines, highlight or filter search, download

## Run
```bash
npm install
npm start
```

## Test
```bash
npm test
```

Passwords and the Anthropic API key are encrypted with the OS keychain (Electron `safeStorage`) and stay in the main process. Host keys are trusted on first use and pinned afterwards.
