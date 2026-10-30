import { describe, expect, it } from 'vitest';

import { editCommand, pathOS } from '@/lib/agent-settings';

describe('editCommand', () => {
  it('picks the shell from the server path, not the browser', () => {
    expect(pathOS('C:\\Users\\Ann\\AppData\\Roaming\\Logsonic\\mcp.json')).toBe('windows');
    expect(pathOS('\\\\server\\share\\mcp.json')).toBe('windows');
    expect(pathOS('/Users/ann/Library/Application Support/Logsonic/mcp.json')).toBe('mac');
    expect(pathOS('/home/ann/.local/share/logsonic/mcp.json')).toBe('unix');
  });

  it('quotes paths for PowerShell on Windows', () => {
    expect(editCommand("C:\\Users\\O'Neil\\AppData\\Roaming\\Logsonic\\mcp.json")).toBe(
      "New-Item -ItemType Directory -Force -Path 'C:\\Users\\O''Neil\\AppData\\Roaming\\Logsonic' | Out-Null; " +
        "if (!(Test-Path 'C:\\Users\\O''Neil\\AppData\\Roaming\\Logsonic\\mcp.json')) { New-Item -ItemType File -Path 'C:\\Users\\O''Neil\\AppData\\Roaming\\Logsonic\\mcp.json' | Out-Null }; " +
        "notepad 'C:\\Users\\O''Neil\\AppData\\Roaming\\Logsonic\\mcp.json'"
    );
  });

  it('opens TextEdit on macOS and $EDITOR elsewhere', () => {
    expect(editCommand('/Users/ann/Library/Application Support/Logsonic/mcp.json')).toBe(
      "mkdir -p '/Users/ann/Library/Application Support/Logsonic' && touch '/Users/ann/Library/Application Support/Logsonic/mcp.json' && open -t '/Users/ann/Library/Application Support/Logsonic/mcp.json'"
    );
    expect(editCommand('/data/mcp.json')).toBe(
      "mkdir -p '/data' && ${EDITOR:-nano} '/data/mcp.json'"
    );
  });
});
