import * as vscode from 'vscode';
import { getSettings } from '../Settings';

export interface ShellSpec {
  command: string;
  args: string[];
}

export function getDefaultShell(): ShellSpec {
  const winOverride = getSettings().shellWindows;
  if (process.platform === 'win32') {
    return { command: winOverride || vscode.env.shell || 'powershell.exe', args: [] };
  }
  return { command: vscode.env.shell || '/bin/bash', args: [] };
}
